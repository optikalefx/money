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

const amazonOrderItemValidator = v.object({
	title: v.string(),
	quantity: v.optional(v.number()),
	amount: v.optional(v.number()),
	category: v.optional(v.string()),
	asin: v.optional(v.string())
});

const amazonRuleClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('dynamic')
);

// Amount tolerance ($) and date window (days) used to match an Amazon order to a Plaid charge.
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

export const listAmazonOrders = query({
	args: {
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.min(args.limit ?? 50, 100);
		const orders = await ctx.db.query('amazonOrders').order('desc').take(limit);

		return Promise.all(
			orders.map(async (order) => {
				const items = await ctx.db
					.query('amazonOrderItems')
					.withIndex('by_amazonOrderId', (q) => q.eq('amazonOrderId', order._id))
					.take(50);

				return {
					id: order._id,
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
						category: item.category ?? null
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

export const upsertAmazonOrder = internalMutation({
	args: {
		gmailMessageId: v.string(),
		orderId: v.optional(v.string()),
		orderDate: v.optional(v.string()),
		subtotal: v.optional(v.number()),
		tax: v.optional(v.number()),
		shipping: v.optional(v.number()),
		total: v.optional(v.number()),
		isoCurrencyCode: v.optional(v.string()),
		items: v.array(amazonOrderItemValidator),
		raw: v.any()
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		// Prefer order-id dedupe: a single Gmail message can contain multiple orders.
		const existing = args.orderId
			? (
					await ctx.db
						.query('amazonOrders')
						.withIndex('by_orderId', (q) => q.eq('orderId', args.orderId))
						.take(1)
				)[0]
			: (
					await ctx.db
						.query('amazonOrders')
						.withIndex('by_gmailMessageId', (q) => q.eq('gmailMessageId', args.gmailMessageId))
						.take(1)
				)[0];

		const match = await findTransactionMatch(ctx, args.total, args.orderDate);
		const orderDoc = {
			gmailMessageId: args.gmailMessageId,
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

		let orderId: Id<'amazonOrders'>;
		if (existing) {
			await ctx.db.patch(existing._id, orderDoc);
			orderId = existing._id;
			// Replace line items so re-parsing a message stays idempotent.
			const oldItems = await ctx.db
				.query('amazonOrderItems')
				.withIndex('by_amazonOrderId', (q) => q.eq('amazonOrderId', orderId))
				.take(200);
			for (const item of oldItems) {
				await ctx.db.delete(item._id);
			}
		} else {
			orderId = await ctx.db.insert('amazonOrders', { ...orderDoc, importedAt: now });
		}

		for (const item of args.items) {
			// Inherit a previously-resolved AI category for this ASIN so re-parsing/new orders
			// stay categorized without another AI call.
			const cachedCategory = item.asin
				? await ctx.db
						.query('amazonItemCategories')
						.withIndex('by_asin', (q) => q.eq('asin', item.asin!))
						.unique()
				: null;
			await ctx.db.insert('amazonOrderItems', {
				amazonOrderId: orderId,
				asin: item.asin,
				title: item.title,
				quantity: item.quantity,
				amount: item.amount,
				category: cachedCategory?.categorySlug ?? item.category,
				categorySource: cachedCategory ? 'ai' : undefined,
				classification: 'dynamic',
				importedAt: now,
				updatedAt: now
			});
		}

		// When this order matches a transaction, let any ASIN rule (re)classify that transaction.
		if (match.transactionId) {
			const asins = args.items.map((item) => item.asin).filter((asin): asin is string => !!asin);
			await applyAmazonItemRules(ctx, match.transactionId, asins);
		}

		return { orderId, matched: match.transactionId !== undefined };
	}
});

// Apply an active ASIN rule to a matched transaction, unless the user set it manually.
async function applyAmazonItemRules(
	ctx: MutationCtx,
	transactionId: Id<'transactions'>,
	asins: string[]
) {
	if (asins.length === 0) return;
	const transaction = await ctx.db.get(transactionId);
	if (!transaction || transaction.removed) return;
	if (transaction.classificationSource === 'manual') return;

	for (const asin of asins) {
		const rule = await ctx.db
			.query('amazonItemRules')
			.withIndex('by_asin', (q) => q.eq('asin', asin))
			.unique();
		if (!rule || !rule.active) continue;

		await ctx.db.patch(transactionId, {
			classification: rule.classification,
			classificationSource: 'merchant_rule',
			classificationConfidence: 1,
			userCategory: rule.category ?? transaction.userCategory,
			reviewedAt: Date.now(),
			updatedAt: Date.now()
		});
		return;
	}
}

export const markAmazonItem = mutation({
	args: {
		transactionId: v.id('transactions'),
		classification: amazonRuleClassification,
		category: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const transaction = await ctx.db.get(args.transactionId);
		if (!transaction || transaction.removed) {
			throw new Error('Transaction is not available for marking.');
		}

		const category = normalizeOptionalText(args.category);

		// Collect the ASINs on the order(s) matched to this transaction.
		const orders = await ctx.db
			.query('amazonOrders')
			.withIndex('by_matchedTransactionId', (q) => q.eq('matchedTransactionId', args.transactionId))
			.take(4);
		const asinToTitle = new Map<string, string>();
		for (const order of orders) {
			const items = await ctx.db
				.query('amazonOrderItems')
				.withIndex('by_amazonOrderId', (q) => q.eq('amazonOrderId', order._id))
				.take(20);
			for (const item of items) {
				if (item.asin) asinToTitle.set(item.asin, item.title);
			}
		}

		// No ASIN available (e.g. unmatched order): fall back to a single-transaction override.
		if (asinToTitle.size === 0) {
			await ctx.db.patch(args.transactionId, {
				classification: args.classification,
				classificationSource: 'manual',
				classificationConfidence: 1,
				userCategory: category ?? transaction.userCategory,
				reviewedAt: now,
				updatedAt: now
			});
			return { ok: true, asins: 0, updated: 1 };
		}

		// Upsert an ASIN rule for each item on the order.
		for (const [asin, title] of asinToTitle) {
			const existing = await ctx.db
				.query('amazonItemRules')
				.withIndex('by_asin', (q) => q.eq('asin', asin))
				.unique();
			const ruleDoc = {
				asin,
				title,
				classification: args.classification,
				category,
				active: true,
				updatedAt: now
			};
			if (existing) {
				await ctx.db.patch(existing._id, ruleDoc);
			} else {
				await ctx.db.insert('amazonItemRules', { ...ruleDoc, createdAt: now });
			}
		}

		// Apply to every transaction whose matched order contains one of these ASINs.
		const targetTransactionIds = new Set<Id<'transactions'>>();
		for (const asin of asinToTitle.keys()) {
			const items = await ctx.db
				.query('amazonOrderItems')
				.withIndex('by_asin', (q) => q.eq('asin', asin))
				.take(500);
			for (const item of items) {
				const order = await ctx.db.get(item.amazonOrderId);
				if (order?.matchedTransactionId) targetTransactionIds.add(order.matchedTransactionId);
			}
		}

		let updated = 0;
		for (const targetId of targetTransactionIds) {
			const target = await ctx.db.get(targetId);
			if (!target || target.removed) continue;
			// Respect existing manual choices on other transactions; always update the clicked one.
			const isClicked = targetId === args.transactionId;
			if (!isClicked && target.classificationSource === 'manual') continue;

			await ctx.db.patch(targetId, {
				classification: args.classification,
				classificationSource: isClicked ? 'manual' : 'merchant_rule',
				classificationConfidence: 1,
				userCategory: category ?? target.userCategory,
				reviewedAt: now,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, asins: asinToTitle.size, updated };
	}
});

export const unmarkAmazonItem = mutation({
	args: { asin: v.string() },
	handler: async (ctx, args) => {
		const now = Date.now();
		const rule = await ctx.db
			.query('amazonItemRules')
			.withIndex('by_asin', (q) => q.eq('asin', args.asin))
			.unique();
		const previousClassification = rule?.classification ?? 'known_recurring';
		if (rule) await ctx.db.delete(rule._id);

		// Reset transactions matched to orders containing this ASIN back to dynamic.
		const items = await ctx.db
			.query('amazonOrderItems')
			.withIndex('by_asin', (q) => q.eq('asin', args.asin))
			.take(500);
		const targetTransactionIds = new Set<Id<'transactions'>>();
		for (const item of items) {
			const order = await ctx.db.get(item.amazonOrderId);
			if (order?.matchedTransactionId) targetTransactionIds.add(order.matchedTransactionId);
		}

		let updated = 0;
		for (const targetId of targetTransactionIds) {
			const target = await ctx.db.get(targetId);
			if (!target || target.removed) continue;
			if (target.classification !== previousClassification) continue;

			await ctx.db.patch(targetId, {
				classification: 'dynamic',
				classificationSource: 'default',
				classificationConfidence: undefined,
				reviewedAt: now,
				updatedAt: now
			});
			updated += 1;
		}

		return { ok: true, updated };
	}
});

async function findTransactionMatch(
	ctx: MutationCtx,
	total: number | undefined,
	orderDate: string | undefined
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
		if (!transaction.normalizedMerchant.includes('amazon')) continue;
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

function normalizeOptionalText(value?: string) {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
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
