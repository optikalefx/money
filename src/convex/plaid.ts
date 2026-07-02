import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import type { Id } from './_generated/dataModel';
import { CATEGORY_OWNED_SOURCES, reclassifyCategoryTransactions, treatmentPatch } from './categories';

const transactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('dynamic'),
	v.literal('unreviewed')
);
const manualTransactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected')
);
const transactionKind = v.union(v.literal('expense'), v.literal('income'), v.literal('transfer'));
const transactionFiltersValidator = {
	limit: v.optional(v.number()),
	classification: v.optional(transactionClassification),
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
	categoryDetailed: v.optional(v.string()),
	raw: v.any()
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
			classification: args.classification,
			startDate: args.startDate,
			endDate: args.endDate,
			search: args.search
		});
		const names = await categoryNameMap(ctx);
		return Promise.all(
			rows.map(async (transaction) => ({
				id: transaction._id,
				date: transaction.date,
				name: transaction.name,
				merchantName: transaction.merchantName ?? null,
				normalizedMerchant: transaction.normalizedMerchant,
				amount: transaction.amount,
				kind: transaction.kind,
				pending: transaction.pending,
				categorySlug: transaction.categorySlug ?? null,
				category: categoryLabel(names, transaction.categorySlug),
				classification: transaction.classification,
				classificationSource: transaction.classificationSource,
				source: transaction.source,
				...(await sourceAccountForTransaction(ctx, transaction)),
				removed: transaction.removed,
				amazonItems: await amazonItemsForTransaction(ctx, transaction)
			}))
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

// The primary (first) purchased item with an ASIN for an Amazon transaction, used to group
// recurring Amazon spend by item instead of by the shared "amazon" merchant.
async function primaryAsinForTransaction(
	ctx: QueryCtx,
	transactionId: Id<'transactions'>
): Promise<{ asin: string; title: string } | null> {
	const order = (
		await ctx.db
			.query('amazonOrders')
			.withIndex('by_matchedTransactionId', (q) => q.eq('matchedTransactionId', transactionId))
			.take(1)
	)[0];
	if (!order) return null;

	const items = await ctx.db
		.query('amazonOrderItems')
		.withIndex('by_amazonOrderId', (q) => q.eq('amazonOrderId', order._id))
		.take(20);
	const item = items.find((candidate) => candidate.asin);
	return item?.asin ? { asin: item.asin, title: item.title } : null;
}

// For Amazon transactions, surface the actual purchased items (from a matched Gmail order)
// so the review queue shows the item bought instead of a generic "Amazon" line.
async function amazonItemsForTransaction(
	ctx: QueryCtx,
	transaction: { _id: Id<'transactions'>; normalizedMerchant: string }
) {
	if (!transaction.normalizedMerchant.includes('amazon')) return [];

	const orders = await ctx.db
		.query('amazonOrders')
		.withIndex('by_matchedTransactionId', (q) => q.eq('matchedTransactionId', transaction._id))
		.take(4);
	const items: Array<{
		title: string;
		quantity: number | null;
		amount: number | null;
		asin: string | null;
		category: string | null;
	}> = [];

	for (const order of orders) {
		const orderItems = await ctx.db
			.query('amazonOrderItems')
			.withIndex('by_amazonOrderId', (q) => q.eq('amazonOrderId', order._id))
			.take(20);
		for (const item of orderItems) {
			items.push({
				title: item.title,
				quantity: item.quantity ?? null,
				amount: item.amount ?? null,
				asin: item.asin ?? null,
				category: item.category ?? null
			});
		}
	}

	return items;
}

export const getDynamicDashboard = query({
	args: {
		startDate: v.string(),
		endDate: v.string()
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) =>
				q.eq('classification', 'dynamic').gte('date', args.startDate).lte('date', args.endDate)
			)
			.order('desc')
			.take(500);
		const activeExpenses = rows.filter(
			(transaction) => !transaction.removed && transaction.kind === 'expense'
		);
		const total = activeExpenses.reduce((sum, transaction) => sum + transaction.amount, 0);
		const names = await categoryNameMap(ctx);
		const byCategory = summarizeBy(activeExpenses, (transaction) =>
			categoryLabel(names, transaction.categorySlug)
		);
		const byMerchant = summarizeBy(
			activeExpenses,
			(transaction) => transaction.merchantName ?? transaction.name
		);
		const trend = summarizeBy(activeExpenses, (transaction) => transaction.date.slice(0, 7));
		const unreviewed = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) =>
				q.eq('classification', 'unreviewed').gte('date', args.startDate).lte('date', args.endDate)
			)
			.take(100);

		return {
			total,
			count: activeExpenses.length,
			byCategory: byCategory.slice(0, 8),
			byMerchant: byMerchant.slice(0, 8),
			trend,
			unreviewedCount: unreviewed.filter((transaction) => !transaction.removed).length,
			recentTransactions: activeExpenses.slice(0, 12).map((transaction) => ({
				id: transaction._id,
				date: transaction.date,
				name: transaction.name,
				merchantName: transaction.merchantName ?? null,
				amount: transaction.amount,
				category: categoryLabel(names, transaction.categorySlug)
			}))
		};
	}
});

// Month-over-month dynamic spend, broken into canonical categories. Amazon charges are
// exploded into their line items so item categories (not the generic "Amazon" bucket) show up.
export const getMonthlyDynamicBreakdown = query({
	args: {
		startMonth: v.string(),
		endMonth: v.string()
	},
	handler: async (ctx, args) => {
		const startDate = `${args.startMonth}-01`;
		const endDate = lastDayOfMonth(args.endMonth);

		const dynamicRows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) =>
				q.eq('classification', 'dynamic').gte('date', startDate).lte('date', endDate)
			)
			.take(2000);
		const unreviewedRows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) =>
				q.eq('classification', 'unreviewed').gte('date', startDate).lte('date', endDate)
			)
			.take(2000);
		const rows = [...dynamicRows, ...unreviewedRows].filter(
			(transaction) => !transaction.removed && transaction.kind === 'expense'
		);

		const categories = await ctx.db
			.query('categories')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(200);
		const categoryName = new Map(categories.map((category) => [category.slug, category.name]));
		const nameFor = (slug: string) => categoryName.get(slug) ?? titleCase(slug);

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

		for (const transaction of rows) {
			const month = transaction.date.slice(0, 7);

			if (transaction.normalizedMerchant.includes('amazon')) {
				const items = await amazonItemsForTransaction(ctx, transaction);
				if (items.length > 0) {
					const amountSum = items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
					for (const item of items) {
						const slug = item.category ?? 'uncategorized';
						// Split the charge across items by item price; fall back to an even split.
						const share =
							amountSum > 0
								? transaction.amount * ((item.amount ?? 0) / amountSum)
								: transaction.amount / items.length;
						add(month, slug, share);
					}
					continue;
				}
			}

			add(month, transaction.categorySlug ?? 'uncategorized', transaction.amount);
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

export const getRecurringSummary = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) => q.eq('classification', 'known_recurring'))
			.order('desc')
			.take(1000);
		const active = rows.filter((transaction) => !transaction.removed);
		const expenses = active.filter((transaction) => transaction.kind === 'expense');
		const total = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
		const names = await categoryNameMap(ctx);
		const byCategory = summarizeBy(expenses, (transaction) =>
			categoryLabel(names, transaction.categorySlug)
		);

		// Amazon recurring is grouped per item (ASIN) rather than lumped under one "amazon" row,
		// so each Subscribe & Save item is its own recurring entry that can be unmarked on its own.
		const merchantTotals = new Map<
			string,
			{
				key: string;
				asin: string | null;
				normalizedMerchant: string;
				label: string;
				total: number;
				count: number;
				months: Set<string>;
			}
		>();
		for (const transaction of expenses) {
			let key = `merchant:${transaction.normalizedMerchant}`;
			let asin: string | null = null;
			let label = transaction.merchantName ?? transaction.name;

			if (transaction.normalizedMerchant.includes('amazon')) {
				const primary = await primaryAsinForTransaction(ctx, transaction._id);
				if (primary) {
					key = `asin:${primary.asin}`;
					asin = primary.asin;
					label = primary.title;
				}
			}

			const existing = merchantTotals.get(key) ?? {
				key,
				asin,
				normalizedMerchant: transaction.normalizedMerchant,
				label,
				total: 0,
				count: 0,
				months: new Set<string>()
			};
			existing.total += transaction.amount;
			existing.count += 1;
			existing.months.add(transaction.date.slice(0, 7));
			merchantTotals.set(key, existing);
		}
		const byMerchant = [...merchantTotals.values()]
			.sort((a, b) => b.total - a.total)
			.map((merchant) => ({
				key: merchant.key,
				asin: merchant.asin,
				normalizedMerchant: merchant.normalizedMerchant,
				label: merchant.label,
				total: merchant.total,
				count: merchant.count,
				monthly: merchant.total / Math.max(merchant.months.size, 1)
			}));
		// Recurring monthly cost = sum of each merchant's average per-month spend.
		const monthlyTotal = byMerchant.reduce((sum, merchant) => sum + merchant.monthly, 0);

		return {
			total,
			monthlyTotal,
			count: active.length,
			expenseCount: expenses.length,
			byCategory: byCategory.slice(0, 12),
			byMerchant: byMerchant.slice(0, 12)
		};
	}
});

export const getRecurringTransactions = query({
	args: {
		startDate: v.optional(v.string()),
		endDate: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) => {
				const withClass = q.eq('classification', 'known_recurring');
				if (args.startDate && args.endDate) {
					return withClass.gte('date', args.startDate).lte('date', args.endDate);
				}
				if (args.startDate) return withClass.gte('date', args.startDate);
				if (args.endDate) return withClass.lte('date', args.endDate);
				return withClass;
			})
			.order('desc')
			.take(500);

		const names = await categoryNameMap(ctx);
		return Promise.all(
			rows
				.filter((transaction) => !transaction.removed)
				.map(async (transaction) => ({
					id: transaction._id,
					date: transaction.date,
					name: transaction.name,
					merchantName: transaction.merchantName ?? null,
					amount: transaction.amount,
					kind: transaction.kind,
					pending: transaction.pending,
					category: categoryLabel(names, transaction.categorySlug),
					classificationSource: transaction.classificationSource,
					source: transaction.source,
					amazonItems: await amazonItemsForTransaction(ctx, transaction)
				}))
		);
	}
});

export const unmarkRecurring = mutation({
	args: {
		normalizedMerchant: v.string()
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const rules = await ctx.db
			.query('merchantRules')
			.withIndex('by_normalizedPattern', (q) => q.eq('normalizedPattern', args.normalizedMerchant))
			.take(10);

		for (const rule of rules) {
			if (rule.classification === 'known_recurring') {
				await ctx.db.delete(rule._id);
			}
		}

		const matchingTransactions = await ctx.db
			.query('transactions')
			.withIndex('by_normalizedMerchant', (q) =>
				q.eq('normalizedMerchant', args.normalizedMerchant)
			)
			.take(500);
		let updated = 0;

		for (const matchingTransaction of matchingTransactions) {
			if (matchingTransaction.removed) continue;
			if (matchingTransaction.classification !== 'known_recurring') continue;

			await ctx.db.patch(matchingTransaction._id, {
				classification: 'dynamic',
				classificationSource: 'default',
				classificationConfidence: undefined,
				reviewedAt: now,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, merchant: args.normalizedMerchant, updated };
	}
});

// Expected things come in two flavors: merchants (merchantRules marked `expected`) and canonical
// categories (categories with `treatment: 'expected'`). This summary lists each alongside its
// transaction totals so they can be reviewed and unmarked on the Expected page.
export const getExpectedSummary = query({
	args: {},
	handler: async (ctx) => {
		const merchantRules = await ctx.db
			.query('merchantRules')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(500);
		const byMerchant = [];
		for (const rule of merchantRules) {
			if (rule.classification !== 'expected') continue;
			const rows = await ctx.db
				.query('transactions')
				.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', rule.normalizedPattern))
				.take(500);
			const expenses = rows.filter(
				(transaction) =>
					!transaction.removed &&
					transaction.classification === 'expected' &&
					transaction.kind === 'expense'
			);
			const total = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
			const months = new Set(expenses.map((transaction) => transaction.date.slice(0, 7)));
			byMerchant.push({
				key: rule.normalizedPattern,
				normalizedMerchant: rule.normalizedPattern,
				label: rule.pattern,
				total,
				count: expenses.length,
				monthly: total / Math.max(months.size, 1)
			});
		}
		byMerchant.sort((a, b) => b.total - a.total);

		const categories = await ctx.db
			.query('categories')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(200);
		const byCategory = [];
		for (const category of categories) {
			if (category.treatment !== 'expected') continue;
			const rows = await ctx.db
				.query('transactions')
				.withIndex('by_categorySlug', (q) => q.eq('categorySlug', category.slug))
				.take(1000);
			const expenses = rows.filter(
				(transaction) =>
					!transaction.removed &&
					transaction.classification === 'expected' &&
					transaction.kind === 'expense'
			);
			const total = expenses.reduce((sum, transaction) => sum + transaction.amount, 0);
			const months = new Set(expenses.map((transaction) => transaction.date.slice(0, 7)));
			byCategory.push({
				key: category.slug,
				slug: category.slug,
				categoryId: category._id,
				label: category.name,
				total,
				count: expenses.length,
				monthly: total / Math.max(months.size, 1)
			});
		}
		byCategory.sort((a, b) => b.total - a.total);

		const monthlyTotal =
			byMerchant.reduce((sum, row) => sum + row.monthly, 0) +
			byCategory.reduce((sum, row) => sum + row.monthly, 0);
		const total =
			byMerchant.reduce((sum, row) => sum + row.total, 0) +
			byCategory.reduce((sum, row) => sum + row.total, 0);
		const count =
			byMerchant.reduce((sum, row) => sum + row.count, 0) +
			byCategory.reduce((sum, row) => sum + row.count, 0);

		return {
			total,
			monthlyTotal,
			count,
			merchantCount: byMerchant.length,
			categoryCount: byCategory.length,
			byMerchant,
			byCategory
		};
	}
});

export const getExpectedTransactions = query({
	args: {
		startDate: v.optional(v.string()),
		endDate: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) => {
				const withClass = q.eq('classification', 'expected');
				if (args.startDate && args.endDate) {
					return withClass.gte('date', args.startDate).lte('date', args.endDate);
				}
				if (args.startDate) return withClass.gte('date', args.startDate);
				if (args.endDate) return withClass.lte('date', args.endDate);
				return withClass;
			})
			.order('desc')
			.take(500);

		const names = await categoryNameMap(ctx);
		return Promise.all(
			rows
				.filter((transaction) => !transaction.removed)
				.map(async (transaction) => ({
					id: transaction._id,
					date: transaction.date,
					name: transaction.name,
					merchantName: transaction.merchantName ?? null,
					amount: transaction.amount,
					kind: transaction.kind,
					pending: transaction.pending,
					category: categoryLabel(names, transaction.categorySlug),
					classificationSource: transaction.classificationSource,
					source: transaction.source,
					amazonItems: await amazonItemsForTransaction(ctx, transaction)
				}))
		);
	}
});

export const unmarkExpectedMerchant = mutation({
	args: {
		normalizedMerchant: v.string()
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const rules = await ctx.db
			.query('merchantRules')
			.withIndex('by_normalizedPattern', (q) => q.eq('normalizedPattern', args.normalizedMerchant))
			.take(10);

		for (const rule of rules) {
			if (rule.classification === 'expected') {
				await ctx.db.delete(rule._id);
			}
		}

		const matchingTransactions = await ctx.db
			.query('transactions')
			.withIndex('by_normalizedMerchant', (q) =>
				q.eq('normalizedMerchant', args.normalizedMerchant)
			)
			.take(500);
		let updated = 0;

		for (const matchingTransaction of matchingTransactions) {
			if (matchingTransaction.removed) continue;
			if (matchingTransaction.classification !== 'expected') continue;

			await ctx.db.patch(matchingTransaction._id, {
				classification: 'dynamic',
				classificationSource: 'default',
				classificationConfidence: undefined,
				reviewedAt: now,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, merchant: args.normalizedMerchant, updated };
	}
});

// Unmarking an expected category is just clearing its treatment — see
// `categories.setCategoryTreatment`, which the Expected page calls with `treatment: null`.

export const markTransaction = mutation({
	args: {
		transactionId: v.id('transactions'),
		classification: manualTransactionClassification,
		notes: v.optional(v.string()),
		createMerchantRule: v.optional(v.boolean()),
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
		// Merchant rules carry only the classification — the category is owned by the canonical
		// AI taxonomy (categorySlug), never a Plaid string threaded through here.
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
			await ctx.db.insert('merchantRules', {
				...ruleDoc,
				createdAt: now
			});
		}

		const matchingTransactions = await ctx.db
			.query('transactions')
			.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', normalizedPattern))
			.take(200);
		let updated = 0;

		for (const matchingTransaction of matchingTransactions) {
			if (matchingTransaction.removed) continue;

			await ctx.db.patch(matchingTransaction._id, {
				classification: args.classification,
				classificationSource: 'merchant_rule',
				classificationConfidence: 1,
				notes: normalizeOptionalText(args.notes),
				reviewedAt: now,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, merchant: normalizedPattern, updated };
	}
});

// Set a treatment on the canonical (AI) category that a transaction belongs to, then reclassify
// every transaction in that category. Keyed on `categorySlug`, never the Plaid provider category.
async function markCategoryTreatment(
	ctx: MutationCtx,
	transactionId: Id<'transactions'>,
	treatment: 'expected' | 'transfer'
) {
	const transaction = await ctx.db.get(transactionId);

	if (!transaction || transaction.removed) {
		throw new Error('Transaction is not available for marking.');
	}

	const slug = transaction.categorySlug;
	if (!slug) {
		throw new Error('Categorize this transaction first, then mark its category.');
	}

	const category = await ctx.db
		.query('categories')
		.withIndex('by_slug', (q) => q.eq('slug', slug))
		.unique();
	if (!category) {
		throw new Error("This transaction's category no longer exists.");
	}

	await ctx.db.patch(category._id, { treatment, updatedAt: Date.now() });
	const updated = await reclassifyCategoryTransactions(ctx, slug, treatment);

	return { ok: true as const, category: category.name, slug, updated };
}

export const markCategoryExpected = mutation({
	args: { transactionId: v.id('transactions') },
	handler: (ctx, args) => markCategoryTreatment(ctx, args.transactionId, 'expected')
});

export const markCategoryTransfer = mutation({
	args: { transactionId: v.id('transactions') },
	handler: (ctx, args) => markCategoryTreatment(ctx, args.transactionId, 'transfer')
});

// Manually assign a canonical category to an uncategorized transaction. This also (a) remembers
// the merchant -> category mapping so future syncs inherit it without an AI call, and (b) applies
// the destination category's treatment (e.g. `expected`) to the merchant's transactions right away.
export const setTransactionCategory = mutation({
	args: {
		transactionId: v.id('transactions'),
		categorySlug: v.string()
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const transaction = await ctx.db.get(args.transactionId);

		if (!transaction || transaction.removed) {
			throw new Error('Transaction is not available for categorizing.');
		}

		const category = await ctx.db
			.query('categories')
			.withIndex('by_slug', (q) => q.eq('slug', args.categorySlug))
			.unique();
		if (!category || !category.active) {
			throw new Error('Category not found.');
		}

		const normalizedMerchant = transaction.normalizedMerchant;

		// Remember this merchant -> category for the future. A manual pick overwrites any cached AI
		// guess and is inherited by later syncs (see `upsertTransaction`).
		const existingCache = await ctx.db
			.query('merchantCategories')
			.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', normalizedMerchant))
			.unique();
		const cacheDoc = {
			normalizedMerchant,
			categorySlug: args.categorySlug,
			source: 'manual' as const,
			active: true,
			updatedAt: now
		};
		if (existingCache) {
			await ctx.db.patch(existingCache._id, cacheDoc);
		} else {
			await ctx.db.insert('merchantCategories', { ...cacheDoc, createdAt: now });
		}

		// Fan the slug out to every transaction from this merchant. If the destination category is
		// `expected`/`transfer`, its treatment classifies the ones the category owns (default- or
		// category-rule-classified) — manual marks and merchant rules still outrank it.
		const treatment = category.treatment ?? null;
		const matching = await ctx.db
			.query('transactions')
			.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', normalizedMerchant))
			.take(500);
		let updated = 0;
		for (const row of matching) {
			if (row.removed) continue;
			const classificationPatch =
				treatment && CATEGORY_OWNED_SOURCES.has(row.classificationSource)
					? { ...treatmentPatch(treatment), reviewedAt: now }
					: {};
			await ctx.db.patch(row._id, {
				categorySlug: args.categorySlug,
				categorySource: 'manual',
				...classificationPatch,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, category: category.name, slug: args.categorySlug, treatment, updated };
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
		raw: unknown;
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
	let transactionDocId: Id<'transactions'>;

	if (existing) {
		// Preserve the existing classification and kind on re-sync so a Plaid "modified" record
		// can't wipe a manual mark, a category-rule transfer, or an Amazon ASIN-rule result.
		const { kind: _kind, ...preservedDoc } = baseDoc;
		await ctx.db.patch(existing._id, preservedDoc);
		transactionDocId = existing._id;
	} else {
		const classification = await classifyFromRules(ctx, transaction.normalizedMerchant);
		// Inherit a previously-resolved AI category for this merchant so re-syncs don't re-hit the AI.
		const cachedCategory = await ctx.db
			.query('merchantCategories')
			.withIndex('by_normalizedMerchant', (q) =>
				q.eq('normalizedMerchant', transaction.normalizedMerchant)
			)
			.unique();
		// When inheriting a cached category, let that category's treatment classify the transaction —
		// unless a merchant rule already claimed it (merchant rules outrank category treatment).
		let categoryClassification = {};
		if (cachedCategory && classification.classificationSource === 'default') {
			const category = await ctx.db
				.query('categories')
				.withIndex('by_slug', (q) => q.eq('slug', cachedCategory.categorySlug))
				.unique();
			if (category?.treatment) {
				categoryClassification = treatmentPatch(category.treatment);
			}
		}
		transactionDocId = await ctx.db.insert('transactions', {
			...baseDoc,
			...classification,
			...(cachedCategory
				? { categorySlug: cachedCategory.categorySlug, categorySource: 'ai' as const }
				: {}),
			...categoryClassification,
			importedAt: now
		});
	}

	const existingSource = await ctx.db
		.query('transactionSources')
		.withIndex('by_source_and_providerId', (q) =>
			q.eq('source', 'plaid').eq('providerId', transaction.transactionId)
		)
		.unique();

	if (existingSource) {
		await ctx.db.patch(existingSource._id, {
			transactionId: transactionDocId,
			raw: transaction.raw,
			updatedAt: now
		});
	} else {
		await ctx.db.insert('transactionSources', {
			source: 'plaid',
			providerId: transaction.transactionId,
			transactionId: transactionDocId,
			raw: transaction.raw,
			importedAt: now,
			updatedAt: now
		});
	}
}

async function readTransactions(
	ctx: QueryCtx,
	args: {
		limit: number;
		classification?: 'known_recurring' | 'expected' | 'dynamic' | 'unreviewed';
		startDate?: string;
		endDate?: string;
		search?: string;
	}
) {
	const takeLimit = args.search ? Math.min(args.limit * 4, 200) : args.limit;
	const rows = args.classification
		? await ctx.db
				.query('transactions')
				.withIndex('by_classification_and_date', (q) => {
					const withClass = q.eq('classification', args.classification!);
					if (args.startDate && args.endDate) {
						return withClass.gte('date', args.startDate).lte('date', args.endDate);
					}
					if (args.startDate) return withClass.gte('date', args.startDate);
					if (args.endDate) return withClass.lte('date', args.endDate);
					return withClass;
				})
				.order('desc')
				.take(takeLimit)
		: await ctx.db
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
				transaction.userCategory,
				transaction.notes
			]
				.filter(Boolean)
				.some((value) => value!.toLowerCase().includes(term))
		)
		.slice(0, args.limit);
}

// Sync-time classification from merchant rules only. Category-driven classification (expected /
// transfer) is applied later, keyed on the canonical AI category once the transaction is
// categorized — never on the Plaid provider category.
async function classifyFromRules(ctx: MutationCtx, normalizedMerchant: string) {
	const merchantRules = await ctx.db
		.query('merchantRules')
		.withIndex('by_active', (q) => q.eq('active', true))
		.take(200);
	const merchantRule = merchantRules.find((rule) => {
		if (rule.matchType === 'exact') return normalizedMerchant === rule.normalizedPattern;
		return normalizedMerchant.includes(rule.normalizedPattern);
	});

	if (merchantRule) {
		return {
			classification: merchantRule.classification,
			classificationSource: 'merchant_rule' as const,
			classificationConfidence: 1
		};
	}

	return {
		classification: 'dynamic' as const,
		classificationSource: 'default' as const,
		classificationConfidence: undefined
	};
}

function summarizeBy<T>(rows: T[], keyFor: (row: T) => string) {
	const totals = new Map<string, { label: string; total: number; count: number }>();

	for (const row of rows as Array<T & { amount: number }>) {
		const label = keyFor(row);
		const existing = totals.get(label) ?? { label, total: 0, count: 0 };
		existing.total += row.amount;
		existing.count += 1;
		totals.set(label, existing);
	}

	return [...totals.values()].sort((a, b) => b.total - a.total);
}

function normalizeOptionalText(value?: string) {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
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

function titleCase(slug: string) {
	return slug
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

// Canonical slug -> display name, loaded once per query. The category shown anywhere is derived
// only from the AI taxonomy (categorySlug); Plaid provider categories are never displayed.
async function categoryNameMap(ctx: QueryCtx) {
	const categories = await ctx.db
		.query('categories')
		.withIndex('by_active', (q) => q.eq('active', true))
		.take(200);
	return new Map(categories.map((category) => [category.slug, category.name]));
}

function categoryLabel(names: Map<string, string>, slug?: string | null) {
	if (!slug || slug === 'uncategorized') return 'Uncategorized';
	return names.get(slug) ?? titleCase(slug);
}
