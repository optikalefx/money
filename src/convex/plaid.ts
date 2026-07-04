import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	query,
	type MutationCtx
} from './_generated/server';
import type { Id } from './_generated/dataModel';
import { rebindUnmatchedOrders } from './gmail';

// Plaid connector + sync internals. Source-agnostic transaction review/reporting (which reads the
// `transactions` table across every source) lives in `transactions.ts`.

const transactionKind = v.union(v.literal('expense'), v.literal('income'), v.literal('transfer'));

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

		// Newly arrived charges may reconcile an order we'd stood up on its own synthetic charge;
		// re-bind those so a real Plaid charge always supersedes the synthetic (never double-count).
		await rebindUnmatchedOrders(ctx);
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
