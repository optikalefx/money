import { v } from 'convex/values';
import { type MutationCtx, type QueryCtx } from './_generated/server';
import { authedQuery as query, authedMutation as mutation } from './authed';
import type { Doc, Id } from './_generated/dataModel';
import { applyMerchantCategory, applyItemCategory } from './categories';
import {
	categoryDisplayLabel,
	loadResolutionData,
	resolveTransactionLineItems,
	type Classification,
	type ResolutionData,
	type ResolvedLineItem
} from './resolution';

// Source-agnostic transaction review + reporting. The `transactions` table holds rows from every
// source (Plaid charges and synthetic Gmail orders), so this module is deliberately not tied to any
// one provider — the Plaid connector and sync internals live in `plaid.ts`.

const manualTransactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected')
);
// Merchant-level marks additionally allow 'transfer' (ignore this merchant's charges).
const merchantMarkClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('transfer')
);
const transactionFiltersValidator = {
	limit: v.optional(v.number()),
	startDate: v.optional(v.string()),
	endDate: v.optional(v.string()),
	search: v.optional(v.string())
};

// Hard ceiling on transactions shipped to the client for one month. The review table pages over
// these client-side, so a normal month (well under this) loads in full and the pager is accurate.
// A month exceeding this is truncated (surfaced in the UI) — that's the point at which we'd move to
// server-side pagination. Keep in sync with `MONTH_ROW_CAP` in src/routes/+page.svelte.
const MONTH_ROW_CAP = 500;

export const listRecentTransactions = query({
	args: transactionFiltersValidator,
	handler: async (ctx, args) => {
		const limit = Math.min(args.limit ?? 100, MONTH_ROW_CAP);
		const term = args.search?.trim().toLowerCase();
		// With a search active, scan wider than `limit` so matches beyond the first rows still
		// surface. Matching runs below over both charge-level and resolved line-item fields (title +
		// canonical category), then we trim back to `limit`.
		const scanLimit = term ? Math.max(limit, 1000) : limit;
		const rows = await readTransactions(ctx, {
			limit: scanLimit,
			startDate: args.startDate,
			endDate: args.endDate
		});
		const data = await loadResolutionData(ctx);
		const resolved = rows.map((transaction) => ({
			transaction,
			lineItems: resolveTransactionLineItems(transaction, data)
		}));
		const matched = term
			? resolved.filter(({ transaction, lineItems }) =>
					[
						transaction.name,
						transaction.merchantName,
						transaction.normalizedMerchant,
						transaction.notes,
						...lineItems.flatMap((item) => [item.title, item.category])
					]
						.filter(Boolean)
						.some((value) => value!.toLowerCase().includes(term))
				)
			: resolved;
		return Promise.all(
			matched.slice(0, limit).map(async ({ transaction, lineItems }) => {
				return {
					id: transaction._id,
					date: transaction.date,
					name: transaction.name,
					merchantName: transaction.merchantName ?? null,
					normalizedMerchant: transaction.normalizedMerchant,
					amount: transaction.amount,
					kind: transaction.kind,
					pending: transaction.pending,
					source: transaction.source,
					...(await sourceAccountForTransaction(ctx, transaction)),
					removed: transaction.removed,
					// The WHAT: each purchased unit with its resolved category + classification. A plain
					// Plaid charge yields one line; a matched order yields its items.
					lineItems: lineItems.map((item) => ({
						merchant: item.merchant,
						orderSource: item.orderSource,
						sku: item.sku,
						title: item.title,
						quantity: item.quantity,
						amount: item.allocatedAmount,
						categorySlug: item.categorySlug,
						category: item.category,
						classification: item.classification,
						kind: item.kind
					}))
				};
			})
		);
	}
});

// The connected account a transaction came from, surfaced next to the source ("plaid") in the
// review queue so a row reads e.g. "plaid · Chase ••1234" instead of a bare provider name.
async function sourceAccountForTransaction(
	ctx: QueryCtx,
	transaction: { accountId?: Id<'accounts'> }
): Promise<{
	institutionName: string | null;
	accountName: string | null;
	accountMask: string | null;
}> {
	if (!transaction.accountId) {
		return { institutionName: null, accountName: null, accountMask: null };
	}
	const account = await ctx.db.get(transaction.accountId);
	if (!account) {
		return { institutionName: null, accountName: null, accountMask: null };
	}
	const item = await ctx.db.get(account.plaidItemId);
	return {
		institutionName: item?.institutionName ?? null,
		accountName: account.name,
		accountMask: account.mask ?? null
	};
}

// Load active transactions in a date range and resolve every line item, each tagged with its
// parent transaction. The shared basis for the dynamic/recurring/expected read paths.
async function resolvedLinesInRange(
	ctx: QueryCtx,
	opts: { startDate?: string; endDate?: string; cap?: number }
): Promise<{
	data: ResolutionData;
	entries: Array<{ transaction: Doc<'transactions'>; line: ResolvedLineItem }>;
}> {
	const rows = await ctx.db
		.query('transactions')
		.withIndex('by_date', (q) => {
			if (opts.startDate && opts.endDate)
				return q.gte('date', opts.startDate).lte('date', opts.endDate);
			if (opts.startDate) return q.gte('date', opts.startDate);
			if (opts.endDate) return q.lte('date', opts.endDate);
			return q;
		})
		.order('desc')
		.take(opts.cap ?? 2000);
	const data = await loadResolutionData(ctx);
	const entries: Array<{ transaction: Doc<'transactions'>; line: ResolvedLineItem }> = [];
	for (const transaction of rows) {
		if (transaction.removed) continue;
		for (const line of resolveTransactionLineItems(transaction, data)) {
			entries.push({ transaction, line });
		}
	}
	return { data, entries };
}

// Month-over-month dynamic spend, broken into canonical categories. Every charge is resolved into
// its line items so item categories (not the generic per-merchant bucket) show up.
export const getMonthlyDynamicBreakdown = query({
	args: {
		startMonth: v.string(),
		endMonth: v.string()
	},
	handler: async (ctx, args) => {
		const startDate = `${args.startMonth}-01`;
		const endDate = lastDayOfMonth(args.endMonth);
		const { data, entries } = await resolvedLinesInRange(ctx, { startDate, endDate });
		const nameFor = (slug: string) => categoryDisplayLabel(data, slug);

		// month -> slug -> total
		const byMonth = new Map<string, Map<string, number>>();
		const totalsByCategory = new Map<string, number>();
		const monthTotals = new Map<string, number>();
		// month -> merchant label -> { total, count } (count is the number of contributing line rows)
		const merchantsByMonth = new Map<string, Map<string, { total: number; count: number }>>();

		const add = (month: string, slug: string, amount: number) => {
			if (amount <= 0) return;
			const monthMap = byMonth.get(month) ?? new Map<string, number>();
			monthMap.set(slug, (monthMap.get(slug) ?? 0) + amount);
			byMonth.set(month, monthMap);
			totalsByCategory.set(slug, (totalsByCategory.get(slug) ?? 0) + amount);
			monthTotals.set(month, (monthTotals.get(month) ?? 0) + amount);
		};

		const addMerchant = (month: string, label: string, amount: number) => {
			if (amount <= 0) return;
			const monthMap =
				merchantsByMonth.get(month) ?? new Map<string, { total: number; count: number }>();
			const existing = monthMap.get(label) ?? { total: 0, count: 0 };
			existing.total += amount;
			existing.count += 1;
			monthMap.set(label, existing);
			merchantsByMonth.set(month, monthMap);
		};

		for (const { transaction, line } of entries) {
			if (line.classification !== 'dynamic' || line.kind !== 'expense') continue;
			const month = transaction.date.slice(0, 7);
			add(month, line.categorySlug, line.allocatedAmount);
			addMerchant(month, transaction.merchantName ?? transaction.name, line.allocatedAmount);
		}

		const months = enumerateMonths(args.startMonth, args.endMonth).map((month) => {
			const monthMap = byMonth.get(month) ?? new Map<string, number>();
			const byCategory = [...monthMap.entries()]
				.map(([slug, total]) => ({ slug, name: nameFor(slug), total }))
				.sort((a, b) => b.total - a.total);
			const merchantMap =
				merchantsByMonth.get(month) ?? new Map<string, { total: number; count: number }>();
			const byMerchant = [...merchantMap.entries()]
				.map(([label, { total, count }]) => ({ label, total, count }))
				.sort((a, b) => b.total - a.total);
			return { month, total: monthTotals.get(month) ?? 0, byCategory, byMerchant };
		});

		return {
			months,
			totalsByCategory: [...totalsByCategory.entries()]
				.map(([slug, total]) => ({ slug, name: nameFor(slug), total }))
				.sort((a, b) => b.total - a.total),
			grandTotal: [...monthTotals.values()].reduce((sum, total) => sum + total, 0)
		};
	}
});

// Group resolved lines of one classification into WHERE/WHAT units: item lines (with a sku) group
// per `(merchant, sku)`; plain lines group per merchant. Reused by the recurring + expected pages.
function groupLinesByUnit(
	entries: Array<{ transaction: Doc<'transactions'>; line: ResolvedLineItem }>
) {
	const units = new Map<
		string,
		{
			key: string;
			merchant: string;
			sku: string | null;
			normalizedMerchant: string;
			label: string;
			total: number;
			count: number;
			months: Set<string>;
		}
	>();
	for (const { transaction, line } of entries) {
		const key = line.sku
			? `item:${line.merchant}:${line.sku}`
			: `merchant:${transaction.normalizedMerchant}`;
		const existing = units.get(key) ?? {
			key,
			merchant: line.merchant,
			sku: line.sku,
			normalizedMerchant: transaction.normalizedMerchant,
			label: line.sku ? line.title : (transaction.merchantName ?? transaction.name),
			total: 0,
			count: 0,
			months: new Set<string>()
		};
		existing.total += line.allocatedAmount;
		existing.count += 1;
		existing.months.add(transaction.date.slice(0, 7));
		units.set(key, existing);
	}
	return [...units.values()]
		.sort((a, b) => b.total - a.total)
		.map((unit) => ({
			key: unit.key,
			merchant: unit.merchant,
			sku: unit.sku,
			asin: unit.sku,
			normalizedMerchant: unit.normalizedMerchant,
			label: unit.label,
			total: unit.total,
			count: unit.count,
			monthly: unit.total / Math.max(unit.months.size, 1)
		}));
}

export const getRecurringSummary = query({
	args: {},
	handler: async (ctx) => {
		const { data, entries } = await resolvedLinesInRange(ctx, { cap: 3000 });
		const recurring = entries.filter(
			({ line }) => line.classification === 'known_recurring' && line.kind === 'expense'
		);
		const total = recurring.reduce((sum, { line }) => sum + line.allocatedAmount, 0);

		const categoryTotals = new Map<string, { label: string; total: number; count: number }>();
		for (const { line } of recurring) {
			const existing = categoryTotals.get(line.category) ?? {
				label: line.category,
				total: 0,
				count: 0
			};
			existing.total += line.allocatedAmount;
			existing.count += 1;
			categoryTotals.set(line.category, existing);
		}
		const byCategory = [...categoryTotals.values()].sort((a, b) => b.total - a.total);
		const byMerchant = groupLinesByUnit(recurring);
		const monthlyTotal = byMerchant.reduce((sum, unit) => sum + unit.monthly, 0);
		const txnIds = new Set(recurring.map(({ transaction }) => transaction._id));
		void data;

		return {
			total,
			monthlyTotal,
			count: txnIds.size,
			expenseCount: recurring.length,
			byCategory: byCategory.slice(0, 12),
			byMerchant: byMerchant.slice(0, 12)
		};
	}
});

// Group a classification's resolved lines back under their parent transactions, preserving the
// per-transaction shape the recurring/expected pages render (with itemized order lines).
function transactionsForClassification(
	entries: Array<{ transaction: Doc<'transactions'>; line: ResolvedLineItem }>,
	classification: Classification
) {
	const byTxn = new Map<
		Id<'transactions'>,
		{ transaction: Doc<'transactions'>; lines: ResolvedLineItem[] }
	>();
	for (const { transaction, line } of entries) {
		if (line.classification !== classification || line.kind !== 'expense') continue;
		const existing = byTxn.get(transaction._id) ?? { transaction, lines: [] };
		existing.lines.push(line);
		byTxn.set(transaction._id, existing);
	}
	return [...byTxn.values()]
		.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date))
		.slice(0, 500)
		.map(({ transaction, lines }) => ({
			id: transaction._id,
			date: transaction.date,
			name: transaction.name,
			merchantName: transaction.merchantName ?? null,
			amount: transaction.amount,
			kind: transaction.kind,
			pending: transaction.pending,
			source: transaction.source,
			// The matching line items, each editable (its category can be changed inline).
			lineItems: lines.map((line) => ({
				merchant: line.merchant,
				orderSource: line.orderSource,
				sku: line.sku,
				title: line.title,
				amount: line.allocatedAmount,
				categorySlug: line.categorySlug,
				category: line.category
			}))
		}));
}

export const getRecurringTransactions = query({
	args: {
		startDate: v.optional(v.string()),
		endDate: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const { entries } = await resolvedLinesInRange(ctx, {
			startDate: args.startDate,
			endDate: args.endDate,
			cap: 3000
		});
		return transactionsForClassification(entries, 'known_recurring');
	}
});

// How many active transactions share a merchant — used for "moved back to dynamic (N)" messaging
// after deleting a rule. Classification isn't stored, so there's nothing to patch.
async function countActiveTransactionsForMerchant(ctx: MutationCtx, normalizedMerchant: string) {
	const rows = await ctx.db
		.query('transactions')
		.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', normalizedMerchant))
		.take(500);
	return rows.filter((transaction) => !transaction.removed).length;
}

// Delete a merchant rule of the given classification. Classification resolves from rules at read
// time, so removing the rule is all it takes — no per-transaction fan-out.
async function deleteMerchantRule(
	ctx: MutationCtx,
	normalizedMerchant: string,
	classification: 'known_recurring' | 'expected' | 'transfer'
) {
	const rules = await ctx.db
		.query('merchantRules')
		.withIndex('by_normalizedPattern', (q) => q.eq('normalizedPattern', normalizedMerchant))
		.take(10);
	for (const rule of rules) {
		if (rule.classification === classification) await ctx.db.delete(rule._id);
	}
	return countActiveTransactionsForMerchant(ctx, normalizedMerchant);
}

export const unmarkRecurring = mutation({
	args: {
		normalizedMerchant: v.string()
	},
	handler: async (ctx, args) => {
		const updated = await deleteMerchantRule(ctx, args.normalizedMerchant, 'known_recurring');
		return { ok: true, merchant: args.normalizedMerchant, updated };
	}
});

// Expected things come in two flavors: merchants (merchantRules marked `expected`) and canonical
// categories (categories with `treatment: 'expected'`). This summary lists each alongside its
// transaction totals so they can be reviewed and unmarked on the Expected page.
export const getExpectedSummary = query({
	args: {},
	handler: async (ctx) => {
		const { data, entries } = await resolvedLinesInRange(ctx, { cap: 3000 });
		const expected = entries.filter(
			({ line }) => line.classification === 'expected' && line.kind === 'expense'
		);

		// Expected via a merchant/item rule → the "by merchant" list (unmark by deleting the rule).
		const byMerchant = groupLinesByUnit(
			expected.filter(({ line }) => line.classificationSource !== 'category')
		);

		// Expected via a category's treatment → the "by category" list (unmark by clearing treatment).
		const categorySlugToId = new Map(
			(
				await ctx.db
					.query('categories')
					.withIndex('by_active', (q) => q.eq('active', true))
					.take(200)
			).map((category) => [category.slug, category._id])
		);
		const categoryUnits = new Map<
			string,
			{ slug: string; label: string; total: number; count: number; months: Set<string> }
		>();
		for (const { transaction, line } of expected) {
			if (line.classificationSource !== 'category') continue;
			const existing = categoryUnits.get(line.categorySlug) ?? {
				slug: line.categorySlug,
				label: line.category,
				total: 0,
				count: 0,
				months: new Set<string>()
			};
			existing.total += line.allocatedAmount;
			existing.count += 1;
			existing.months.add(transaction.date.slice(0, 7));
			categoryUnits.set(line.categorySlug, existing);
		}
		const byCategory = [...categoryUnits.values()]
			.sort((a, b) => b.total - a.total)
			.map((unit) => ({
				key: unit.slug,
				slug: unit.slug,
				categoryId: categorySlugToId.get(unit.slug) ?? null,
				label: unit.label,
				total: unit.total,
				count: unit.count,
				monthly: unit.total / Math.max(unit.months.size, 1)
			}));

		// Merchants ignored as transfers (non-spending, e.g. credit-card payments). Unmark by
		// deleting the transfer rule.
		const byTransfer = groupLinesByUnit(entries.filter(({ line }) => line.kind === 'transfer'));

		const monthlyTotal =
			byMerchant.reduce((sum, row) => sum + row.monthly, 0) +
			byCategory.reduce((sum, row) => sum + row.monthly, 0);
		const total =
			byMerchant.reduce((sum, row) => sum + row.total, 0) +
			byCategory.reduce((sum, row) => sum + row.total, 0);
		const count =
			byMerchant.reduce((sum, row) => sum + row.count, 0) +
			byCategory.reduce((sum, row) => sum + row.count, 0);
		void data;

		return {
			total,
			monthlyTotal,
			count,
			merchantCount: byMerchant.length,
			categoryCount: byCategory.length,
			transferCount: byTransfer.length,
			byMerchant,
			byCategory,
			byTransfer
		};
	}
});

export const getExpectedTransactions = query({
	args: {
		startDate: v.optional(v.string()),
		endDate: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const { entries } = await resolvedLinesInRange(ctx, {
			startDate: args.startDate,
			endDate: args.endDate,
			cap: 3000
		});
		return transactionsForClassification(entries, 'expected');
	}
});

export const unmarkExpectedMerchant = mutation({
	args: {
		normalizedMerchant: v.string()
	},
	handler: async (ctx, args) => {
		const updated = await deleteMerchantRule(ctx, args.normalizedMerchant, 'expected');
		return { ok: true, merchant: args.normalizedMerchant, updated };
	}
});

export const unmarkTransferMerchant = mutation({
	args: {
		normalizedMerchant: v.string()
	},
	handler: async (ctx, args) => {
		const updated = await deleteMerchantRule(ctx, args.normalizedMerchant, 'transfer');
		return { ok: true, merchant: args.normalizedMerchant, updated };
	}
});

// Unmarking an expected category is just clearing its treatment — see
// `categories.setCategoryTreatment`, which the Expected page calls with `treatment: null`.

// Mark the merchant (WHERE) of a transaction as expected/recurring: upsert a merchant rule. No
// fan-out — every line resolves its classification from this rule at read time.
export const markTransaction = mutation({
	args: {
		transactionId: v.id('transactions'),
		classification: merchantMarkClassification,
		ruleMatchType: v.optional(v.union(v.literal('exact'), v.literal('contains')))
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const transaction = await ctx.db.get(args.transactionId);
		if (!transaction || transaction.removed) {
			throw new Error('Transaction is not available for marking.');
		}

		const pattern = transaction.merchantName ?? transaction.name;
		const normalizedPattern = transaction.normalizedMerchant;
		const existingRule = (
			await ctx.db
				.query('merchantRules')
				.withIndex('by_normalizedPattern', (q) => q.eq('normalizedPattern', normalizedPattern))
				.take(1)
		)[0];
		const ruleDoc = {
			matchType: args.ruleMatchType ?? ('exact' as const),
			pattern,
			normalizedPattern,
			classification: args.classification,
			active: true,
			updatedAt: now
		};
		if (existingRule) {
			await ctx.db.patch(existingRule._id, ruleDoc);
		} else {
			await ctx.db.insert('merchantRules', { ...ruleDoc, createdAt: now });
		}

		const updated = await countActiveTransactionsForMerchant(ctx, normalizedPattern);
		return { ok: true, merchant: normalizedPattern, updated };
	}
});

// Mark an item (WHAT) of a transaction as expected/recurring: upsert an item rule keyed on
// `(merchant, sku)`. Only sku-bearing lines (e.g. parsed order items) can have item rules.
export const markLineItem = mutation({
	args: {
		merchant: v.string(),
		sku: v.string(),
		title: v.optional(v.string()),
		classification: manualTransactionClassification
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query('itemRules')
			.withIndex('by_merchant_sku', (q) => q.eq('merchant', args.merchant).eq('sku', args.sku))
			.unique();
		const ruleDoc = {
			merchant: args.merchant,
			sku: args.sku,
			title: args.title,
			classification: args.classification,
			active: true,
			updatedAt: now
		};
		if (existing) {
			await ctx.db.patch(existing._id, ruleDoc);
		} else {
			await ctx.db.insert('itemRules', { ...ruleDoc, createdAt: now });
		}
		return { ok: true, updated: await countTransactionsForSku(ctx, args.sku) };
	}
});

export const unmarkLineItem = mutation({
	args: { merchant: v.string(), sku: v.string() },
	handler: async (ctx, args) => {
		const rule = await ctx.db
			.query('itemRules')
			.withIndex('by_merchant_sku', (q) => q.eq('merchant', args.merchant).eq('sku', args.sku))
			.unique();
		if (rule) await ctx.db.delete(rule._id);
		return { ok: true, updated: await countTransactionsForSku(ctx, args.sku) };
	}
});

// How many matched transactions contain a given sku — for "moved back to dynamic (N)" messaging.
async function countTransactionsForSku(ctx: MutationCtx, sku: string) {
	const items = await ctx.db
		.query('orderItems')
		.withIndex('by_sku', (q) => q.eq('sku', sku))
		.take(500);
	const txnIds = new Set<Id<'transactions'>>();
	for (const item of items) {
		const order = await ctx.db.get(item.orderId);
		if (order?.matchedTransactionId) txnIds.add(order.matchedTransactionId);
	}
	return txnIds.size;
}

// Mark a canonical category as expected/transfer by setting its treatment. Every line in the
// category resolves to that treatment at read time — no fan-out.
async function setCategoryTreatmentBySlug(
	ctx: MutationCtx,
	categorySlug: string,
	treatment: 'expected' | 'transfer'
) {
	if (!categorySlug || categorySlug === 'uncategorized') {
		throw new Error('Categorize this first, then mark its category.');
	}
	const category = await ctx.db
		.query('categories')
		.withIndex('by_slug', (q) => q.eq('slug', categorySlug))
		.unique();
	if (!category) throw new Error('Category not found.');
	await ctx.db.patch(category._id, { treatment, updatedAt: Date.now() });
	return { ok: true as const, category: category.name, slug: categorySlug };
}

export const markCategoryExpected = mutation({
	args: { categorySlug: v.string() },
	handler: (ctx, args) => setCategoryTreatmentBySlug(ctx, args.categorySlug, 'expected')
});

// Manually assign a canonical category to a line item. A sku-bearing line writes the item cache
// `(merchant, sku)`; a plain Plaid line writes the merchant cache. Manual picks outrank AI and
// fan automatically: every line sharing that key resolves to the new category on the next read.
export const setLineItemCategory = mutation({
	args: {
		merchant: v.string(),
		sku: v.optional(v.string()),
		categorySlug: v.string()
	},
	handler: async (ctx, args) => {
		const category = await ctx.db
			.query('categories')
			.withIndex('by_slug', (q) => q.eq('slug', args.categorySlug))
			.unique();
		if (!category || !category.active) throw new Error('Category not found.');

		if (args.sku) {
			await applyItemCategory(ctx, args.merchant, args.sku, args.categorySlug, {
				source: 'manual'
			});
		} else {
			await applyMerchantCategory(ctx, args.merchant, args.categorySlug, { source: 'manual' });
		}

		return {
			ok: true,
			category: category.name,
			slug: args.categorySlug,
			treatment: category.treatment ?? null
		};
	}
});

export const listRules = query({
	args: {},
	handler: async (ctx) => {
		const merchantRules = await ctx.db
			.query('merchantRules')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(100);

		return {
			merchantRules: merchantRules.map((rule) => ({
				id: rule._id,
				pattern: rule.pattern,
				matchType: rule.matchType,
				classification: rule.classification
			}))
		};
	}
});

// Recent transactions in a date range for the review queue. Classification is resolved by the
// caller (per line item); this just fetches candidate charges in the range.
async function readTransactions(
	ctx: QueryCtx,
	args: {
		limit: number;
		startDate?: string;
		endDate?: string;
	}
) {
	const rows = await ctx.db
		.query('transactions')
		.withIndex('by_date', (q) => {
			if (args.startDate && args.endDate) {
				return q.gte('date', args.startDate).lte('date', args.endDate);
			}
			if (args.startDate) return q.gte('date', args.startDate);
			if (args.endDate) return q.lte('date', args.endDate);
			return q;
		})
		.order('desc')
		.take(args.limit);

	return rows.filter((transaction) => !transaction.removed);
}

function lastDayOfMonth(month: string) {
	const [year, monthIndex] = month.split('-').map(Number);
	const day = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
	return `${month}-${String(day).padStart(2, '0')}`;
}

// Inclusive list of YYYY-MM strings from start to end (capped to avoid runaway ranges).
function enumerateMonths(startMonth: string, endMonth: string) {
	const months: string[] = [];
	let [year, month] = startMonth.split('-').map(Number);
	const [endYear, endMonthNum] = endMonth.split('-').map(Number);
	for (let guard = 0; guard < 240; guard++) {
		if (year > endYear || (year === endYear && month > endMonthNum)) break;
		months.push(`${year}-${String(month).padStart(2, '0')}`);
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return months;
}
