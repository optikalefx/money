import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx
} from './_generated/server';
import type { Id } from './_generated/dataModel';

const connectionStatus = v.union(
	v.literal('connected'),
	v.literal('needs_reconnect'),
	v.literal('error'),
	v.literal('disabled')
);

const orderItemValidator = v.object({
	title: v.string(),
	quantity: v.optional(v.number()),
	amount: v.optional(v.number()),
	sku: v.optional(v.string())
});

// Amount tolerance ($) and date window (days) used to match a parsed order to a Plaid charge.
const MATCH_AMOUNT_TOLERANCE = 0.01;
const MATCH_DATE_WINDOW_DAYS = 5;

export const getConnectionStatus = query({
	args: {},
	handler: async (ctx) => {
		const account = await ctx.db.query('gmailAccounts').take(1);
		const gmail = account[0];

		if (!gmail) {
			return { connected: false, status: null, email: null, lastSyncAt: null };
		}

		return {
			connected: gmail.status === 'connected',
			status: gmail.status,
			email: gmail.email ?? null,
			lastSyncAt: gmail.lastSyncAt ?? null,
			errorMessage: gmail.errorMessage ?? null
		};
	}
});

export const listOrders = query({
	args: {
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.min(args.limit ?? 50, 100);
		const orders = await ctx.db.query('orders').order('desc').take(limit);

		return Promise.all(
			orders.map(async (order) => {
				const items = await ctx.db
					.query('orderItems')
					.withIndex('by_orderId', (q) => q.eq('orderId', order._id))
					.take(50);

				return {
					id: order._id,
					merchant: order.merchant,
					orderId: order.orderId ?? null,
					orderDate: order.orderDate ?? null,
					total: order.total ?? null,
					subtotal: order.subtotal ?? null,
					tax: order.tax ?? null,
					shipping: order.shipping ?? null,
					reviewState: order.reviewState ?? 'unmatched',
					matchedTransactionId: order.matchedTransactionId ?? null,
					matchConfidence: order.matchConfidence ?? null,
					items: items.map((item) => ({
						id: item._id,
						title: item.title,
						quantity: item.quantity ?? null,
						amount: item.amount ?? null,
						sku: item.sku ?? null
					}))
				};
			})
		);
	}
});

export const createOAuthState = internalMutation({
	args: { returnTo: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const state = crypto.randomUUID();
		await ctx.db.insert('oauthStates', {
			provider: 'gmail',
			state,
			returnTo: args.returnTo,
			createdAt: Date.now()
		});
		return state;
	}
});

export const consumeOAuthState = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('oauthStates')
			.withIndex('by_state', (q) => q.eq('state', args.state))
			.unique();

		if (!existing) return { valid: false, returnTo: null };

		await ctx.db.delete(existing._id);
		// Reject states older than 15 minutes.
		const valid = Date.now() - existing.createdAt < 15 * 60 * 1000;
		return { valid, returnTo: existing.returnTo ?? null };
	}
});

export const storeGmailToken = internalMutation({
	args: {
		refreshToken: v.string(),
		accessToken: v.optional(v.string()),
		accessTokenExpiresAt: v.optional(v.number()),
		scope: v.optional(v.string()),
		email: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = (await ctx.db.query('gmailAccounts').take(1))[0];
		const doc = {
			refreshToken: args.refreshToken,
			accessToken: args.accessToken,
			accessTokenExpiresAt: args.accessTokenExpiresAt,
			scope: args.scope,
			email: args.email,
			status: 'connected' as const,
			updatedAt: now,
			errorCode: undefined,
			errorMessage: undefined
		};

		if (existing) {
			await ctx.db.patch(existing._id, doc);
			return existing._id;
		}

		return await ctx.db.insert('gmailAccounts', {
			...doc,
			connectedAt: now
		});
	}
});

export const getGmailAccount = internalQuery({
	args: {},
	handler: async (ctx) => {
		return (await ctx.db.query('gmailAccounts').take(1))[0] ?? null;
	}
});

export const updateAccessToken = internalMutation({
	args: {
		accountId: v.id('gmailAccounts'),
		accessToken: v.string(),
		accessTokenExpiresAt: v.number()
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.accountId, {
			accessToken: args.accessToken,
			accessTokenExpiresAt: args.accessTokenExpiresAt,
			updatedAt: Date.now()
		});
	}
});

export const finishGmailSync = internalMutation({
	args: {
		accountId: v.id('gmailAccounts'),
		lastMessageEpochMs: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const patch: Record<string, unknown> = { lastSyncAt: now, updatedAt: now, status: 'connected' };
		if (args.lastMessageEpochMs !== undefined) {
			patch.lastMessageEpochMs = args.lastMessageEpochMs;
		}
		await ctx.db.patch(args.accountId, patch);
	}
});

export const markGmailError = internalMutation({
	args: {
		accountId: v.id('gmailAccounts'),
		status: connectionStatus,
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.accountId, {
			status: args.status,
			errorCode: args.errorCode,
			errorMessage: args.errorMessage,
			updatedAt: Date.now()
		});
	}
});

export const upsertOrder = internalMutation({
	args: {
		source: v.literal('gmail'),
		merchant: v.string(),
		sourceMessageId: v.string(),
		orderId: v.optional(v.string()),
		orderDate: v.optional(v.string()),
		subtotal: v.optional(v.number()),
		tax: v.optional(v.number()),
		shipping: v.optional(v.number()),
		total: v.optional(v.number()),
		isoCurrencyCode: v.optional(v.string()),
		items: v.array(orderItemValidator),
		// Merchant-name patterns for matching this order to a Plaid charge (from the adapter).
		merchantMatchers: v.array(v.string()),
		raw: v.any()
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		// Prefer order-id dedupe: a single email can contain multiple orders.
		const existing = args.orderId
			? (
					await ctx.db
						.query('orders')
						.withIndex('by_orderId', (q) => q.eq('orderId', args.orderId))
						.take(1)
				)[0]
			: (
					await ctx.db
						.query('orders')
						.withIndex('by_sourceMessageId', (q) => q.eq('sourceMessageId', args.sourceMessageId))
						.take(1)
				)[0];

		const match = await findTransactionMatch(ctx, args.total, args.orderDate, args.merchantMatchers);
		const orderDoc = {
			source: args.source,
			merchant: args.merchant,
			sourceMessageId: args.sourceMessageId,
			orderId: args.orderId,
			orderDate: args.orderDate,
			subtotal: args.subtotal,
			tax: args.tax,
			shipping: args.shipping,
			total: args.total,
			isoCurrencyCode: args.isoCurrencyCode,
			reviewState: match.reviewState,
			matchedTransactionId: match.transactionId,
			matchConfidence: match.confidence,
			raw: args.raw,
			updatedAt: now
		};

		let orderId: Id<'orders'>;
		if (existing) {
			await ctx.db.patch(existing._id, orderDoc);
			orderId = existing._id;
			// Replace line items so re-parsing a message stays idempotent.
			const oldItems = await ctx.db
				.query('orderItems')
				.withIndex('by_orderId', (q) => q.eq('orderId', orderId))
				.take(200);
			for (const item of oldItems) {
				await ctx.db.delete(item._id);
			}
		} else {
			orderId = await ctx.db.insert('orders', { ...orderDoc, importedAt: now });
		}

		for (const item of args.items) {
			await ctx.db.insert('orderItems', {
				orderId,
				sku: item.sku,
				title: item.title,
				quantity: item.quantity,
				amount: item.amount,
				importedAt: now,
				updatedAt: now
			});
		}

		return { orderId, matched: match.transactionId !== undefined };
	}
});

async function findTransactionMatch(
	ctx: MutationCtx,
	total: number | undefined,
	orderDate: string | undefined,
	merchantMatchers: string[]
): Promise<{
	transactionId?: Id<'transactions'>;
	confidence?: number;
	reviewState: 'unmatched' | 'matched' | 'review';
}> {
	if (total === undefined || !orderDate) {
		return { reviewState: 'unmatched' };
	}

	const start = shiftDate(orderDate, -MATCH_DATE_WINDOW_DAYS);
	const end = shiftDate(orderDate, MATCH_DATE_WINDOW_DAYS);
	const candidates = await ctx.db
		.query('transactions')
		.withIndex('by_date', (q) => q.gte('date', start).lte('date', end))
		.take(500);

	let best: { id: Id<'transactions'>; distance: number } | undefined;
	for (const transaction of candidates) {
		if (transaction.removed) continue;
		// Only consider charges whose merchant matches this retailer's patterns.
		if (!merchantMatchers.some((pattern) => transaction.normalizedMerchant.includes(pattern))) {
			continue;
		}
		if (Math.abs(transaction.amount - total) > MATCH_AMOUNT_TOLERANCE) continue;
		const distance = Math.abs(dateDiffDays(transaction.date, orderDate));
		if (!best || distance < best.distance) {
			best = { id: transaction._id, distance };
		}
	}

	if (!best) {
		return { reviewState: 'unmatched' };
	}

	// Same-day amount match is high confidence; farther out is worth a manual look.
	const confidence = best.distance <= 1 ? 0.95 : 0.7;
	return {
		transactionId: best.id,
		confidence,
		reviewState: confidence >= 0.9 ? 'matched' : 'review'
	};
}

function shiftDate(date: string, days: number) {
	const time = new Date(`${date}T00:00:00Z`).getTime() + days * 24 * 60 * 60 * 1000;
	return new Date(time).toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string) {
	const aTime = new Date(`${a}T00:00:00Z`).getTime();
	const bTime = new Date(`${b}T00:00:00Z`).getTime();
	return Math.round((aTime - bTime) / (24 * 60 * 60 * 1000));
}
