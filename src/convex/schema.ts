import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const connectionProvider = v.union(v.literal('plaid'), v.literal('gmail'));
const connectionStatus = v.union(
	v.literal('connected'),
	v.literal('needs_reconnect'),
	v.literal('error'),
	v.literal('disabled')
);
const transactionSource = v.union(v.literal('plaid'), v.literal('gmail_amazon'));
const transactionKind = v.union(v.literal('expense'), v.literal('income'), v.literal('transfer'));
const transactionClassification = v.union(
	v.literal('known_recurring'),
	v.literal('expected'),
	v.literal('dynamic'),
	v.literal('unreviewed')
);
const classificationSource = v.union(
	v.literal('manual'),
	v.literal('merchant_rule'),
	v.literal('category_rule'),
	v.literal('ai'),
	v.literal('default')
);
const syncSource = v.union(v.literal('plaid'), v.literal('gmail'), v.literal('ai'));
const syncStatus = v.union(v.literal('running'), v.literal('success'), v.literal('error'));

export default defineSchema({
	connections: defineTable({
		provider: connectionProvider,
		status: connectionStatus,
		displayName: v.string(),
		connectedAt: v.number(),
		updatedAt: v.number(),
		lastSyncAt: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	})
		.index('by_provider', ['provider'])
		.index('by_provider_and_status', ['provider', 'status']),

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
		categoryPrimary: v.optional(v.string()),
		categoryDetailed: v.optional(v.string()),
		userCategory: v.optional(v.string()),
		// Resolved canonical category (slug) for the month-over-month dashboard.
		categorySlug: v.optional(v.string()),
		categorySource: v.optional(v.union(v.literal('ai'), v.literal('manual'))),
		classification: transactionClassification,
		classificationSource: classificationSource,
		classificationConfidence: v.optional(v.number()),
		reviewedAt: v.optional(v.number()),
		notes: v.optional(v.string()),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_source_and_providerTransactionId', ['source', 'providerTransactionId'])
		.index('by_date', ['date'])
		.index('by_classification_and_date', ['classification', 'date'])
		.index('by_accountId_and_date', ['accountId', 'date'])
		.index('by_normalizedMerchant', ['normalizedMerchant'])
		.index('by_categoryDetailed', ['categoryDetailed'])
		.index('by_categoryPrimary', ['categoryPrimary'])
		.index('by_categorySlug', ['categorySlug']),

	transactionSources: defineTable({
		source: transactionSource,
		providerId: v.string(),
		transactionId: v.optional(v.id('transactions')),
		raw: v.any(),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_source_and_providerId', ['source', 'providerId'])
		.index('by_transactionId', ['transactionId']),

	merchantRules: defineTable({
		matchType: v.union(v.literal('exact'), v.literal('contains')),
		pattern: v.string(),
		normalizedPattern: v.string(),
		classification: v.union(
			v.literal('known_recurring'),
			v.literal('expected'),
			v.literal('dynamic')
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

	amazonOrders: defineTable({
		gmailMessageId: v.string(),
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
		.index('by_gmailMessageId', ['gmailMessageId'])
		.index('by_orderId', ['orderId'])
		.index('by_reviewState', ['reviewState'])
		.index('by_matchedTransactionId', ['matchedTransactionId']),

	amazonOrderItems: defineTable({
		amazonOrderId: v.id('amazonOrders'),
		asin: v.optional(v.string()),
		title: v.string(),
		quantity: v.optional(v.number()),
		amount: v.optional(v.number()),
		// Resolved canonical category (slug) stored in `category`; source tracks who set it.
		category: v.optional(v.string()),
		categorySource: v.optional(v.union(v.literal('ai'), v.literal('manual'))),
		classification: transactionClassification,
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_amazonOrderId', ['amazonOrderId'])
		.index('by_asin', ['asin'])
		.index('by_classification', ['classification']),

	// User rules keyed on Amazon ASIN so repeat purchases (e.g. Subscribe & Save) auto-classify.
	amazonItemRules: defineTable({
		asin: v.string(),
		title: v.optional(v.string()),
		classification: v.union(
			v.literal('known_recurring'),
			v.literal('expected'),
			v.literal('dynamic')
		),
		category: v.optional(v.string()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_asin', ['asin']),

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

	// Per-ASIN AI category cache so each Amazon item is categorized once and new orders inherit.
	amazonItemCategories: defineTable({
		asin: v.string(),
		title: v.optional(v.string()),
		categorySlug: v.string(),
		source: v.union(v.literal('ai'), v.literal('manual')),
		model: v.optional(v.string()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_asin', ['asin']),

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
				kind: v.union(v.literal('merchant'), v.literal('asin')),
				key: v.string(),
				title: v.optional(v.string()),
				weight: v.number()
			})
		),
		status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('dismissed')),
		model: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_status', ['status']),

	aiClassifications: defineTable({
		transactionId: v.id('transactions'),
		promptVersion: v.string(),
		model: v.string(),
		inputHash: v.string(),
		classification: transactionClassification,
		category: v.optional(v.string()),
		confidence: v.number(),
		reason: v.string(),
		applied: v.boolean(),
		createdAt: v.number()
	})
		.index('by_transactionId', ['transactionId'])
		.index('by_applied', ['applied']),

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
