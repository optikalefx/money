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
		.index('by_categoryPrimary', ['categoryPrimary']),

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
		category: v.optional(v.string()),
		expectedMonthlyAmount: v.optional(v.number()),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_normalizedPattern', ['normalizedPattern']),

	categoryRules: defineTable({
		providerCategory: v.string(),
		classification: v.union(v.literal('expected'), v.literal('dynamic')),
		kind: v.optional(transactionKind),
		category: v.string(),
		active: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_active', ['active'])
		.index('by_providerCategory', ['providerCategory']),

	amazonOrders: defineTable({
		gmailMessageId: v.string(),
		orderId: v.optional(v.string()),
		orderDate: v.optional(v.string()),
		total: v.optional(v.number()),
		matchedTransactionId: v.optional(v.id('transactions')),
		matchConfidence: v.optional(v.number()),
		raw: v.any(),
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_gmailMessageId', ['gmailMessageId'])
		.index('by_orderId', ['orderId'])
		.index('by_matchedTransactionId', ['matchedTransactionId']),

	amazonOrderItems: defineTable({
		amazonOrderId: v.id('amazonOrders'),
		title: v.string(),
		quantity: v.optional(v.number()),
		amount: v.optional(v.number()),
		category: v.optional(v.string()),
		classification: transactionClassification,
		importedAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_amazonOrderId', ['amazonOrderId'])
		.index('by_classification', ['classification']),

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
