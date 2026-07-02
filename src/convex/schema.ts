import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const connectionStatus = v.union(
	v.literal('connected'),
	v.literal('needs_reconnect'),
	v.literal('error'),
	v.literal('disabled')
);
const transactionSource = v.union(v.literal('plaid'), v.literal('gmail_amazon'));
const transactionKind = v.union(v.literal('expense'), v.literal('income'), v.literal('transfer'));
const syncSource = v.union(v.literal('plaid'), v.literal('gmail'), v.literal('ai'));
const syncStatus = v.union(v.literal('running'), v.literal('success'), v.literal('error'));

export default defineSchema({
	plaidItems: defineTable({
		itemId: v.string(),
		accessToken: v.string(),
		institutionId: v.optional(v.string()),
		institutionName: v.optional(v.string()),
		status: connectionStatus,
		cursor: v.optional(v.string()),
		connectedAt: v.number(),
		updatedAt: v.number(),
		lastSyncAt: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	})
		.index('by_itemId', ['itemId'])
		.index('by_status', ['status']),

	accounts: defineTable({
		plaidItemId: v.id('plaidItems'),
		providerAccountId: v.string(),
		name: v.string(),
		officialName: v.optional(v.string()),
		mask: v.optional(v.string()),
		type: v.optional(v.string()),
		subtype: v.optional(v.string()),
		currentBalance: v.optional(v.number()),
		availableBalance: v.optional(v.number()),
		isoCurrencyCode: v.optional(v.string()),
		updatedAt: v.number()
	})
		.index('by_plaidItemId', ['plaidItemId'])
		.index('by_providerAccountId', ['providerAccountId']),

	// A transaction is the WHERE + money: one bank charge that reconciles to the statement.
	// Category and classification are NOT stored here — they are resolved at read time from the
	// rule/cache tables (see resolution.ts). What was bought (the WHAT) lives in line items:
	// a plain Plaid charge is one synthesized line item; a matched order explodes into its items.
	transactions: defineTable({
		source: transactionSource,
		providerTransactionId: v.optional(v.string()),
		accountId: v.optional(v.id('accounts')),
		providerAccountId: v.optional(v.string()),
		date: v.string(),
		authorizedDate: v.optional(v.string()),
		name: v.string(),
		merchantName: v.optional(v.string()),
		normalizedMerchant: v.string(),
		amount: v.number(),
		kind: transactionKind,
		isoCurrencyCode: v.optional(v.string()),
		pending: v.boolean(),
		removed: v.boolean(),
		// Raw provider category hints, kept only as input to the AI categorizer.
		categoryPrimary: v.optional(v.string()),
		categoryDetailed: v.optional(v.string()),
		notes: v.optional(v.string()),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_source_and_providerTransactionId', ['source', 'providerTransactionId'])
		.index('by_date', ['date'])
		.index('by_accountId_and_date', ['accountId', 'date'])
		.index('by_normalizedMerchant', ['normalizedMerchant']),

	merchantRules: defineTable({
		matchType: v.union(v.literal('exact'), v.literal('contains')),
		pattern: v.string(),
		normalizedPattern: v.string(),
		// `transfer` marks the merchant's charges as non-spending (e.g. a credit-card payment),
		// resolved to kind 'transfer' and excluded from the dynamic queue and breakdown.
		classification: v.union(
			v.literal('known_recurring'),
			v.literal('expected'),
			v.literal('dynamic'),
			v.literal('transfer')
		),
		expectedMonthlyAmount: v.optional(v.number()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_normalizedPattern', ['normalizedPattern']),

	gmailAccounts: defineTable({
		email: v.optional(v.string()),
		refreshToken: v.string(),
		accessToken: v.optional(v.string()),
		accessTokenExpiresAt: v.optional(v.number()),
		scope: v.optional(v.string()),
		status: connectionStatus,
		lastSyncAt: v.optional(v.number()),
		// Highest Gmail internalDate (epoch ms) processed, used to only fetch newer messages.
		lastMessageEpochMs: v.optional(v.number()),
		connectedAt: v.number(),
		updatedAt: v.number(),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	}).index('by_status', ['status']),

	oauthStates: defineTable({
		provider: v.literal('gmail'),
		state: v.string(),
		returnTo: v.optional(v.string()),
		createdAt: v.number()
	}).index('by_state', ['state']),

	// A parsed order/receipt from an email adapter (Amazon today, any store tomorrow). `source` is
	// the import provenance (gmail); `merchant` is the canonical store ('amazon'). Its line items
	// live in `orderItems`; when matched to a transaction they become that charge's line items.
	orders: defineTable({
		source: v.union(v.literal('gmail')),
		merchant: v.string(),
		sourceMessageId: v.string(),
		orderId: v.optional(v.string()),
		orderDate: v.optional(v.string()),
		subtotal: v.optional(v.number()),
		tax: v.optional(v.number()),
		shipping: v.optional(v.number()),
		total: v.optional(v.number()),
		isoCurrencyCode: v.optional(v.string()),
		reviewState: v.optional(
			v.union(v.literal('unmatched'), v.literal('matched'), v.literal('review'))
		),
		matchedTransactionId: v.optional(v.id('transactions')),
		matchConfidence: v.optional(v.number()),
		raw: v.any(),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_sourceMessageId', ['sourceMessageId'])
		.index('by_orderId', ['orderId'])
		.index('by_reviewState', ['reviewState'])
		.index('by_matchedTransactionId', ['matchedTransactionId']),

	// Parsed line items belonging to an order. Purely descriptive (the WHAT) — category and
	// classification are resolved at read time from `(merchant, sku)` rule/cache tables.
	orderItems: defineTable({
		orderId: v.id('orders'),
		sku: v.optional(v.string()),
		title: v.string(),
		quantity: v.optional(v.number()),
		amount: v.optional(v.number()),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_orderId', ['orderId'])
		.index('by_sku', ['sku']),

	// User classification rules keyed on a product `(merchant, sku)` so repeat purchases
	// (e.g. Subscribe & Save) auto-classify — the "expected item" / "recurring item" rules.
	itemRules: defineTable({
		merchant: v.string(),
		sku: v.string(),
		title: v.optional(v.string()),
		classification: v.union(
			v.literal('known_recurring'),
			v.literal('expected'),
			v.literal('dynamic')
		),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_merchant_sku', ['merchant', 'sku']),

	// User-editable canonical taxonomy. Every category is AI-driven: `description` tells the
	// AI how to decide a transaction belongs here (may be blank when the name is self-evident).
	categories: defineTable({
		slug: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		color: v.optional(v.string()),
		sortOrder: v.number(),
		// How transactions in this canonical category should be classified. Absent = the default
		// (dynamic). `expected` treats them as expected spend; `transfer` ignores them as transfers.
		// This is the canonical, AI-taxonomy-driven replacement for the old Plaid `categoryRules`.
		treatment: v.optional(v.union(v.literal('expected'), v.literal('transfer'))),
		active: v.boolean(),
		isDefault: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_slug', ['slug']),

	// Per-merchant AI category cache for non-Amazon transactions, so each merchant is
	// categorized once and future syncs inherit without another AI call.
	merchantCategories: defineTable({
		normalizedMerchant: v.string(),
		categorySlug: v.string(),
		source: v.union(v.literal('ai'), v.literal('manual')),
		model: v.optional(v.string()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_normalizedMerchant', ['normalizedMerchant']),

	// Per-product `(merchant, sku)` category cache/assignment so each item is categorized once and
	// new orders inherit. A manual pick writes here with `source: 'manual'` and outranks AI.
	itemCategories: defineTable({
		merchant: v.string(),
		sku: v.string(),
		title: v.optional(v.string()),
		categorySlug: v.string(),
		source: v.union(v.literal('ai'), v.literal('manual')),
		model: v.optional(v.string()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_merchant_sku', ['merchant', 'sku']),

	// Single-row app configuration for the pluggable AI provider/model.
	appConfig: defineTable({
		aiProvider: v.union(v.literal('openai'), v.literal('anthropic')),
		aiModel: v.string(),
		updatedAt: v.number()
	}),

	// Durable audit trail of AI categorization calls: the exact prompt sent, the parsed
	// response, and token usage, one row per chunk. Lets you inspect what the AI saw/returned.
	aiRuns: defineTable({
		kind: v.string(),
		model: v.string(),
		chunkIndex: v.number(),
		chunkCount: v.number(),
		unitCount: v.number(),
		prompt: v.string(),
		results: v.any(),
		usage: v.optional(v.any()),
		createdAt: v.number()
	}).index('by_createdAt', ['createdAt']),

	// AI-proposed new categories derived from the `uncategorized` bucket, awaiting the user's
	// accept/dismiss. `members` are the merchant/ASIN units the AI grouped under the suggestion,
	// so accepting can immediately move them out of Uncategorized.
	categorySuggestions: defineTable({
		slug: v.string(),
		name: v.string(),
		description: v.string(),
		memberCount: v.number(),
		weight: v.number(),
		members: v.array(
			v.object({
				kind: v.union(v.literal('merchant'), v.literal('item')),
				// For a merchant member: the normalizedMerchant. For an item member: the sku.
				key: v.string(),
				// The canonical merchant, present on item members so `(merchant, sku)` is resolvable.
				merchant: v.optional(v.string()),
				title: v.optional(v.string()),
				weight: v.number()
			})
		),
		status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('dismissed')),
		model: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_status', ['status']),

	syncRuns: defineTable({
		source: syncSource,
		status: syncStatus,
		startedAt: v.number(),
		finishedAt: v.optional(v.number()),
		added: v.optional(v.number()),
		modified: v.optional(v.number()),
		removed: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	})
		.index('by_source_and_startedAt', ['source', 'startedAt'])
		.index('by_status', ['status'])
});
