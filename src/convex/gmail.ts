import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { authedQuery as query } from './authed';
import type { Doc, Id } from './_generated/dataModel';
import { RETAILER_ADAPTERS } from './adapters';

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
// Retailers charge when an order *ships*, typically several days after the confirmation email — and
// always on/after the order date, never before. So search a wide window forward and only a small
// margin backward (for authorize-vs-email timing and time zones).
const MATCH_DAYS_BEFORE = 3;
const MATCH_DAYS_AFTER = 14;

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

// One-shot maintenance: re-bind every order to an owning transaction. Unlike the sync-time
// `rebindUnmatchedOrders` (which only upgrades to a newly-arrived real charge), this also stands up
// a synthetic charge for orders imported before standalone binding existed. Safe to re-run.
const retailerMatchers = () =>
	new Map(RETAILER_ADAPTERS.map((adapter) => [adapter.merchant, adapter.merchantMatchers]));

// Re-resolve one order's binding (real charge > synthetic > unbound) and persist it. Returns 1 if it
// ended up bound to some transaction, else 0.
async function reconcileOneOrder(
	ctx: MutationCtx,
	order: Doc<'orders'>,
	matchersByMerchant: Map<string, string[]>
): Promise<number> {
	const matchers = matchersByMerchant.get(order.merchant) ?? [order.merchant];
	const binding = await resolveOrderBinding(
		ctx,
		{
			total: order.total,
			orderDate: order.orderDate,
			merchant: order.merchant,
			currentMatchedTransactionId: order.matchedTransactionId
		},
		matchers
	);
	await ctx.db.patch(order._id, {
		matchedTransactionId: binding.matchedTransactionId,
		reviewState: binding.reviewState,
		matchConfidence: binding.matchConfidence,
		updatedAt: Date.now()
	});
	return binding.matchedTransactionId ? 1 : 0;
}

export async function reconcileOrders(ctx: MutationCtx) {
	const matchersByMerchant = retailerMatchers();
	const orders = await ctx.db.query('orders').take(4000);
	let bound = 0;
	for (const order of orders) bound += await reconcileOneOrder(ctx, order, matchersByMerchant);
	return { scanned: orders.length, bound };
}

export const reconcileOrderBindings = internalMutation({
	args: {},
	handler: async (ctx) => reconcileOrders(ctx)
});

// Paginated variant so a full re-match (every order re-scanned against the wide date window) stays
// within a single mutation's read limit. The `rematchOrders` action drives it batch by batch.
export const reconcileOrderBatch = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const matchersByMerchant = retailerMatchers();
		const page = await ctx.db.query('orders').paginate({ numItems: 50, cursor: args.cursor });
		let bound = 0;
		for (const order of page.page) {
			bound += await reconcileOneOrder(ctx, order, matchersByMerchant);
		}
		return { scanned: page.page.length, bound, cursor: page.continueCursor, isDone: page.isDone };
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

		// Bind the order to an owning transaction: a real Plaid charge if the matcher finds one, else a
		// synthetic `gmail` transaction so the order (and its items) is visible on its own.
		const binding = await resolveOrderBinding(
			ctx,
			{
				total: args.total,
				orderDate: args.orderDate,
				merchant: args.merchant,
				currentMatchedTransactionId: existing?.matchedTransactionId
			},
			args.merchantMatchers
		);
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
			reviewState: binding.reviewState,
			matchedTransactionId: binding.matchedTransactionId,
			matchConfidence: binding.matchConfidence,
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

		return { orderId, matched: binding.reviewState !== 'unmatched' };
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

	const start = shiftDate(orderDate, -MATCH_DAYS_BEFORE);
	const end = shiftDate(orderDate, MATCH_DAYS_AFTER);
	const candidates = await ctx.db
		.query('transactions')
		.withIndex('by_date', (q) => q.gte('date', start).lte('date', end))
		.take(500);

	let best: { id: Id<'transactions'>; distance: number } | undefined;
	for (const transaction of candidates) {
		if (transaction.removed) continue;
		// Only reconcile against real bank charges, never another order's synthetic gmail transaction.
		if (transaction.source !== 'plaid') continue;
		// Only consider charges whose merchant matches this retailer's patterns.
		if (!merchantMatchers.some((pattern) => transaction.normalizedMerchant.includes(pattern))) {
			continue;
		}
		if (Math.abs(transaction.amount - total) > MATCH_AMOUNT_TOLERANCE) continue;
		// Rank by the charge date closest to the order email, preferring `authorizedDate` (when the
		// card was authorized, ~order time) over the posted `date` (which lags by the ship delay).
		const postedDistance = Math.abs(dateDiffDays(transaction.date, orderDate));
		const authDistance = transaction.authorizedDate
			? Math.abs(dateDiffDays(transaction.authorizedDate, orderDate))
			: postedDistance;
		const distance = Math.min(postedDistance, authDistance);
		if (!best || distance < best.distance) {
			best = { id: transaction._id, distance };
		}
	}

	if (!best) {
		return { reviewState: 'unmatched' };
	}

	// Close in time = high confidence (auto-matched); farther out is worth a manual look.
	const confidence = best.distance <= 2 ? 0.95 : 0.7;
	return {
		transactionId: best.id,
		confidence,
		reviewState: confidence >= 0.9 ? 'matched' : 'review'
	};
}

// The minimum an order needs to stand up as its own charge: a positive total on a dated day.
type OrderBindingInput = {
	total?: number;
	orderDate?: string;
	merchant: string;
	currentMatchedTransactionId?: Id<'transactions'>;
};

type OrderBinding = {
	matchedTransactionId?: Id<'transactions'>;
	reviewState: 'unmatched' | 'matched' | 'review';
	matchConfidence?: number;
};

// A human display label for a canonical merchant slug ('amazon' → 'Amazon', 'best-buy' → 'Best Buy').
function retailerLabel(merchant: string): string {
	return merchant
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

// The synthetic transaction an order currently owns (if any). An order's `matchedTransactionId`
// points either at a real Plaid charge or at the synthetic `gmail` charge we minted for it; only the
// latter (`source: 'gmail'`) is ours to patch or delete.
async function loadOwnedSynthetic(
	ctx: MutationCtx,
	transactionId?: Id<'transactions'>
): Promise<Doc<'transactions'> | null> {
	if (!transactionId) return null;
	const transaction = await ctx.db.get(transactionId);
	return transaction && transaction.source === 'gmail' ? transaction : null;
}

// Create (or update) the synthetic charge that carries a standalone order. It is just the WHERE +
// money; the order's parsed items resolve as its line items at read time. The retailer is carried by
// `normalizedMerchant`, so this is store-agnostic (Amazon today, Walmart or any adapter tomorrow).
async function upsertSyntheticTransaction(
	ctx: MutationCtx,
	existingId: Id<'transactions'> | undefined,
	order: OrderBindingInput & { total: number; orderDate: string }
): Promise<Id<'transactions'>> {
	const now = Date.now();
	const label = retailerLabel(order.merchant);
	const doc = {
		source: 'gmail' as const,
		date: order.orderDate,
		name: `${label} order`,
		merchantName: label,
		normalizedMerchant: order.merchant,
		amount: order.total,
		kind: 'expense' as const,
		pending: false,
		removed: false,
		updatedAt: now
	};
	if (existingId) {
		await ctx.db.patch(existingId, doc);
		return existingId;
	}
	return await ctx.db.insert('transactions', { ...doc, importedAt: now });
}

// Decide which transaction owns an order, keeping "counted exactly once" true by construction:
// a real Plaid charge wins (and any synthetic is discarded); otherwise the order stands on its own
// synthetic charge when it has a usable total; otherwise it stays unbound (a parse failure).
async function resolveOrderBinding(
	ctx: MutationCtx,
	order: OrderBindingInput,
	merchantMatchers: string[]
): Promise<OrderBinding> {
	const existingSynthetic = await loadOwnedSynthetic(ctx, order.currentMatchedTransactionId);
	const match = await findTransactionMatch(ctx, order.total, order.orderDate, merchantMatchers);

	if (match.transactionId) {
		if (existingSynthetic) await ctx.db.delete(existingSynthetic._id);
		return {
			matchedTransactionId: match.transactionId,
			reviewState: match.reviewState,
			matchConfidence: match.confidence
		};
	}

	if (order.total !== undefined && order.total > 0 && order.orderDate) {
		const syntheticId = await upsertSyntheticTransaction(ctx, existingSynthetic?._id, {
			...order,
			total: order.total,
			orderDate: order.orderDate
		});
		return { matchedTransactionId: syntheticId, reviewState: 'unmatched' };
	}

	// Nothing to bind to (missing/zero total). Drop any stale synthetic so it can't linger as noise.
	if (existingSynthetic) await ctx.db.delete(existingSynthetic._id);
	return { matchedTransactionId: undefined, reviewState: 'unmatched' };
}

// After a Plaid sync brings in new charges, upgrade any order still standing on a synthetic charge
// (or fully unbound) whose real bank charge has now arrived: re-point it and drop the synthetic.
export async function rebindUnmatchedOrders(ctx: MutationCtx) {
	const matchersByMerchant = new Map(
		RETAILER_ADAPTERS.map((adapter) => [adapter.merchant, adapter.merchantMatchers])
	);
	const orders = await ctx.db
		.query('orders')
		.withIndex('by_reviewState', (q) => q.eq('reviewState', 'unmatched'))
		.take(2000);

	for (const order of orders) {
		const matchers = matchersByMerchant.get(order.merchant) ?? [order.merchant];
		const match = await findTransactionMatch(ctx, order.total, order.orderDate, matchers);
		if (!match.transactionId) continue; // still no real charge — leave the standalone as-is.

		const synthetic = await loadOwnedSynthetic(ctx, order.matchedTransactionId);
		if (synthetic) await ctx.db.delete(synthetic._id);
		await ctx.db.patch(order._id, {
			matchedTransactionId: match.transactionId,
			reviewState: match.reviewState,
			matchConfidence: match.confidence,
			updatedAt: Date.now()
		});
	}
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
