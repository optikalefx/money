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

const transactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('dynamic'),
	v.literal('unreviewed')
);
const manualTransactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('dynamic')
);
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
	kind: v.union(v.literal('expense'), v.literal('income'), v.literal('transfer')),
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
		return rows.map((transaction) => ({
			id: transaction._id,
			date: transaction.date,
			name: transaction.name,
			merchantName: transaction.merchantName ?? null,
			normalizedMerchant: transaction.normalizedMerchant,
			amount: transaction.amount,
			kind: transaction.kind,
			pending: transaction.pending,
			categoryPrimary: transaction.categoryPrimary ?? null,
			categoryDetailed: transaction.categoryDetailed ?? null,
			userCategory: transaction.userCategory ?? null,
			classification: transaction.classification,
			classificationSource: transaction.classificationSource,
			source: transaction.source,
			removed: transaction.removed
		}));
	}
});

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
		const byCategory = summarizeBy(
			activeExpenses,
			(transaction) =>
				transaction.userCategory ??
				transaction.categoryDetailed ??
				transaction.categoryPrimary ??
				'Uncategorized'
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
				category:
					transaction.userCategory ??
					transaction.categoryDetailed ??
					transaction.categoryPrimary ??
					'Uncategorized'
			}))
		};
	}
});

export const markTransaction = mutation({
	args: {
		transactionId: v.id('transactions'),
		classification: manualTransactionClassification,
		category: v.optional(v.string()),
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

		const userCategory = normalizeOptionalText(args.category);
		const notes = normalizeOptionalText(args.notes);

		await ctx.db.patch(args.transactionId, {
			classification: args.classification,
			classificationSource: 'manual',
			classificationConfidence: 1,
			userCategory,
			notes,
			reviewedAt: now,
			updatedAt: now
		});

		if (args.createMerchantRule) {
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
				category: userCategory,
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
		}

		return { ok: true };
	}
});

export const listRules = query({
	args: {},
	handler: async (ctx) => {
		const merchantRules = await ctx.db
			.query('merchantRules')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(100);
		const categoryRules = await ctx.db
			.query('categoryRules')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(100);

		return {
			merchantRules: merchantRules.map((rule) => ({
				id: rule._id,
				pattern: rule.pattern,
				matchType: rule.matchType,
				classification: rule.classification,
				category: rule.category ?? null
			})),
			categoryRules: categoryRules.map((rule) => ({
				id: rule._id,
				providerCategory: rule.providerCategory,
				classification: rule.classification,
				category: rule.category
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
		const classification =
			existing.classificationSource === 'manual'
				? {}
				: await classifyFromRules(
						ctx,
						transaction.normalizedMerchant,
						transaction.categoryDetailed
					);
		await ctx.db.patch(existing._id, {
			...baseDoc,
			...classification
		});
		transactionDocId = existing._id;
	} else {
		const classification = await classifyFromRules(
			ctx,
			transaction.normalizedMerchant,
			transaction.categoryDetailed
		);
		transactionDocId = await ctx.db.insert('transactions', {
			...baseDoc,
			...classification,
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

async function classifyFromRules(
	ctx: MutationCtx,
	normalizedMerchant: string,
	categoryDetailed?: string
) {
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
			classificationConfidence: 1,
			userCategory: merchantRule.category
		};
	}

	if (categoryDetailed) {
		const categoryRule = (
			await ctx.db
				.query('categoryRules')
				.withIndex('by_providerCategory', (q) => q.eq('providerCategory', categoryDetailed))
				.take(1)
		)[0];

		if (categoryRule?.active) {
			return {
				classification: categoryRule.classification,
				classificationSource: 'category_rule' as const,
				classificationConfidence: 0.9,
				userCategory: categoryRule.category
			};
		}
	}

	return {
		classification: 'unreviewed' as const,
		classificationSource: 'default' as const,
		classificationConfidence: undefined,
		userCategory: undefined
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
