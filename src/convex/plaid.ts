import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
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
const transactionKind = v.union(v.literal('expense'), v.literal('income'), v.literal('transfer'));
const transactionFiltersValidator = {
	limit: v.optional(v.number()),
	startDate: v.optional(v.string()),
	endDate: v.optional(v.string()),
	search: v.optional(v.string())
};

const plaidTransactionValidator = v.object({
	transactionId: v.string(),
	accountId: v.string(),
	date: v.string(),
	authorizedDate: v.optional(v.string()),
	name: v.string(),
	merchantName: v.optional(v.string()),
	normalizedMerchant: v.string(),
	amount: v.number(),
	kind: transactionKind,
	isoCurrencyCode: v.optional(v.string()),
	pending: v.boolean(),
	categoryPrimary: v.optional(v.string()),
	categoryDetailed: v.optional(v.string())
});

function publicItem(item: {
	_id: Id<'plaidItems'>;
	itemId: string;
	institutionName?: string;
	status: 'connected' | 'needs_reconnect' | 'error' | 'disabled';
	lastSyncAt?: number;
	errorCode?: string;
	errorMessage?: string;
}) {
	return {
		id: item._id,
		itemId: item.itemId,
		institutionName: item.institutionName ?? 'Plaid item',
		status: item.status,
		lastSyncAt: item.lastSyncAt ?? null,
		errorCode: item.errorCode ?? null,
		errorMessage: item.errorMessage ?? null
	};
}

export const getConnectionStatus = query({
	args: {},
	handler: async (ctx) => {
		const connectedItems = await ctx.db
			.query('plaidItems')
			.withIndex('by_status', (q) => q.eq('status', 'connected'))
			.take(10);
		const needsReconnect = await ctx.db
			.query('plaidItems')
			.withIndex('by_status', (q) => q.eq('status', 'needs_reconnect'))
			.take(10);
		const accounts = await ctx.db.query('accounts').take(50);

		return {
			connected: connectedItems.length > 0,
			items: [...connectedItems, ...needsReconnect].map(publicItem),
			accounts: accounts.map((account) => ({
				id: account._id,
				name: account.name,
				mask: account.mask ?? null,
				type: account.type ?? null,
				subtype: account.subtype ?? null
			}))
		};
	}
});

export const listRecentTransactions = query({
	args: transactionFiltersValidator,
	handler: async (ctx, args) => {
		const limit = Math.min(args.limit ?? 50, 100);
		const rows = await readTransactions(ctx, {
			limit,
			startDate: args.startDate,
			endDate: args.endDate,
			search: args.search
		});
		const data = await loadResolutionData(ctx);
		return Promise.all(
			rows.map(async (transaction) => {
				const lineItems = resolveTransactionLineItems(transaction, data);
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
): Promise<{ institutionName: string | null; accountName: string | null; accountMask: string | null }> {
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
			if (opts.startDate && opts.endDate) return q.gte('date', opts.startDate).lte('date', opts.endDate);
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
// its line items so item categories (not the generic "Amazon" bucket) show up.
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

		const add = (month: string, slug: string, amount: number) => {
			if (amount <= 0) return;
			const monthMap = byMonth.get(month) ?? new Map<string, number>();
			monthMap.set(slug, (monthMap.get(slug) ?? 0) + amount);
			byMonth.set(month, monthMap);
			totalsByCategory.set(slug, (totalsByCategory.get(slug) ?? 0) + amount);
			monthTotals.set(month, (monthTotals.get(month) ?? 0) + amount);
		};

		for (const { transaction, line } of entries) {
			if (line.classification !== 'dynamic' || line.kind !== 'expense') continue;
			add(transaction.date.slice(0, 7), line.categorySlug, line.allocatedAmount);
		}

		const months = enumerateMonths(args.startMonth, args.endMonth).map((month) => {
			const monthMap = byMonth.get(month) ?? new Map<string, number>();
			const byCategory = [...monthMap.entries()]
				.map(([slug, total]) => ({ slug, name: nameFor(slug), total }))
				.sort((a, b) => b.total - a.total);
			return { month, total: monthTotals.get(month) ?? 0, byCategory };
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
	return [...units.values()].sort((a, b) => b.total - a.total).map((unit) => ({
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
// per-transaction shape the recurring/expected pages render (with itemized lines as `amazonItems`).
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
// `(merchant, sku)`. Only sku-bearing lines (e.g. Amazon items) can have item rules.
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
			await applyItemCategory(ctx, args.merchant, args.sku, args.categorySlug, { source: 'manual' });
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

export const listActiveItems = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('plaidItems')
			.withIndex('by_status', (q) => q.eq('status', 'connected'))
			.take(20);
	}
});

export const storePlaidItem = internalMutation({
	args: {
		itemId: v.string(),
		accessToken: v.string(),
		institutionId: v.optional(v.string()),
		institutionName: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query('plaidItems')
			.withIndex('by_itemId', (q) => q.eq('itemId', args.itemId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				accessToken: args.accessToken,
				institutionId: args.institutionId,
				institutionName: args.institutionName,
				status: 'connected',
				updatedAt: now,
				errorCode: undefined,
				errorMessage: undefined
			});
			return existing._id;
		}

		return await ctx.db.insert('plaidItems', {
			itemId: args.itemId,
			accessToken: args.accessToken,
			institutionId: args.institutionId,
			institutionName: args.institutionName,
			status: 'connected',
			connectedAt: now,
			updatedAt: now
		});
	}
});

export const upsertAccounts = internalMutation({
	args: {
		plaidItemId: v.id('plaidItems'),
		accounts: v.array(
			v.object({
				accountId: v.string(),
				name: v.string(),
				officialName: v.optional(v.string()),
				mask: v.optional(v.string()),
				type: v.optional(v.string()),
				subtype: v.optional(v.string()),
				currentBalance: v.optional(v.number()),
				availableBalance: v.optional(v.number()),
				isoCurrencyCode: v.optional(v.string())
			})
		)
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		for (const account of args.accounts) {
			const existing = await ctx.db
				.query('accounts')
				.withIndex('by_providerAccountId', (q) => q.eq('providerAccountId', account.accountId))
				.unique();
			const doc = {
				plaidItemId: args.plaidItemId,
				providerAccountId: account.accountId,
				name: account.name,
				officialName: account.officialName,
				mask: account.mask,
				type: account.type,
				subtype: account.subtype,
				currentBalance: account.currentBalance,
				availableBalance: account.availableBalance,
				isoCurrencyCode: account.isoCurrencyCode,
				updatedAt: now
			};

			if (existing) {
				await ctx.db.patch(existing._id, doc);
			} else {
				await ctx.db.insert('accounts', doc);
			}
		}
	}
});

export const startSyncRun = internalMutation({
	args: {
		source: v.union(v.literal('plaid'), v.literal('gmail'), v.literal('ai'))
	},
	handler: async (ctx, args) => {
		return await ctx.db.insert('syncRuns', {
			source: args.source,
			status: 'running',
			startedAt: Date.now()
		});
	}
});

export const finishSyncRun = internalMutation({
	args: {
		syncRunId: v.id('syncRuns'),
		status: v.union(v.literal('success'), v.literal('error')),
		added: v.optional(v.number()),
		modified: v.optional(v.number()),
		removed: v.optional(v.number()),
		errorMessage: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.syncRunId, {
			status: args.status,
			finishedAt: Date.now(),
			added: args.added,
			modified: args.modified,
			removed: args.removed,
			errorMessage: args.errorMessage
		});
	}
});

export const applyTransactionSync = internalMutation({
	args: {
		plaidItemId: v.id('plaidItems'),
		cursor: v.string(),
		added: v.array(plaidTransactionValidator),
		modified: v.array(plaidTransactionValidator),
		removed: v.array(
			v.object({
				transactionId: v.string(),
				accountId: v.string()
			})
		)
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		for (const transaction of [...args.added, ...args.modified]) {
			await upsertTransaction(ctx, transaction, now);
		}

		for (const removed of args.removed) {
			const existing = await ctx.db
				.query('transactions')
				.withIndex('by_source_and_providerTransactionId', (q) =>
					q.eq('source', 'plaid').eq('providerTransactionId', removed.transactionId)
				)
				.unique();

			if (existing) {
				await ctx.db.patch(existing._id, {
					removed: true,
					updatedAt: now
				});
			}
		}

		await ctx.db.patch(args.plaidItemId, {
			cursor: args.cursor,
			lastSyncAt: now,
			updatedAt: now,
			status: 'connected',
			errorCode: undefined,
			errorMessage: undefined
		});
	}
});

async function upsertTransaction(
	ctx: MutationCtx,
	transaction: {
		transactionId: string;
		accountId: string;
		date: string;
		authorizedDate?: string;
		name: string;
		merchantName?: string;
		normalizedMerchant: string;
		amount: number;
		kind: 'expense' | 'income' | 'transfer';
		isoCurrencyCode?: string;
		pending: boolean;
		categoryPrimary?: string;
		categoryDetailed?: string;
	},
	now: number
) {
	const account = await ctx.db
		.query('accounts')
		.withIndex('by_providerAccountId', (q) => q.eq('providerAccountId', transaction.accountId))
		.unique();
	const existing = await ctx.db
		.query('transactions')
		.withIndex('by_source_and_providerTransactionId', (q) =>
			q.eq('source', 'plaid').eq('providerTransactionId', transaction.transactionId)
		)
		.unique();
	const baseDoc = {
		source: 'plaid' as const,
		providerTransactionId: transaction.transactionId,
		accountId: account?._id,
		providerAccountId: transaction.accountId,
		date: transaction.date,
		authorizedDate: transaction.authorizedDate,
		name: transaction.name,
		merchantName: transaction.merchantName,
		normalizedMerchant: transaction.normalizedMerchant,
		amount: transaction.amount,
		kind: transaction.kind,
		isoCurrencyCode: transaction.isoCurrencyCode,
		pending: transaction.pending,
		removed: false,
		categoryPrimary: transaction.categoryPrimary,
		categoryDetailed: transaction.categoryDetailed,
		updatedAt: now
	};

	// A transaction is just the WHERE + money now. Category and classification are resolved at read
	// time from the rule/cache tables, so there's nothing classification-related to preserve or seed.
	if (existing) {
		await ctx.db.patch(existing._id, baseDoc);
	} else {
		await ctx.db.insert('transactions', { ...baseDoc, importedAt: now });
	}
}

// Recent transactions in a date range for the review queue. Classification is resolved by the
// caller (per line item); this just fetches candidate charges and applies the text search.
async function readTransactions(
	ctx: QueryCtx,
	args: {
		limit: number;
		startDate?: string;
		endDate?: string;
		search?: string;
	}
) {
	const takeLimit = args.search ? Math.min(args.limit * 4, 200) : args.limit;
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
		.take(takeLimit);

	const activeRows = rows.filter((transaction) => !transaction.removed);
	const term = args.search?.trim().toLowerCase();
	if (!term) return activeRows.slice(0, args.limit);

	return activeRows
		.filter((transaction) =>
			[
				transaction.name,
				transaction.merchantName,
				transaction.normalizedMerchant,
				transaction.categoryPrimary,
				transaction.categoryDetailed,
				transaction.notes
			]
				.filter(Boolean)
				.some((value) => value!.toLowerCase().includes(term))
		)
		.slice(0, args.limit);
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
