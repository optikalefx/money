'use node';

import {
	Configuration,
	CountryCode,
	PlaidApi,
	PlaidEnvironments,
	Products,
	type RemovedTransaction,
	type Transaction
} from 'plaid';
import { v } from 'convex/values';
import { action, env, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

type PlaidEnvironment = 'sandbox' | 'development' | 'production';

function plaidClient() {
	const plaidEnv = (env.PLAID_ENV || 'sandbox') as PlaidEnvironment;
	const basePath = PlaidEnvironments[plaidEnv];

	if (!basePath) {
		throw new Error(`Unsupported PLAID_ENV: ${plaidEnv}`);
	}

	return new PlaidApi(
		new Configuration({
			basePath,
			baseOptions: {
				headers: {
					'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
					'PLAID-SECRET': env.PLAID_SECRET
				}
			}
		})
	);
}

function normalizeMerchant(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

type TransactionKind = 'expense' | 'income' | 'transfer';

type MappedPlaidTransaction = {
	transactionId: string;
	accountId: string;
	date: string;
	authorizedDate?: string;
	name: string;
	merchantName?: string;
	normalizedMerchant: string;
	amount: number;
	kind: TransactionKind;
	isoCurrencyCode?: string;
	pending: boolean;
	categoryPrimary?: string;
	categoryDetailed?: string;
};

function transactionKind(amount: number): TransactionKind {
	if (amount > 0) return 'expense';
	if (amount < 0) return 'income';
	return 'transfer';
}

function categoryPrimary(transaction: Transaction) {
	return transaction.personal_finance_category?.primary || transaction.category?.[0] || undefined;
}

function categoryDetailed(transaction: Transaction) {
	return (
		transaction.personal_finance_category?.detailed || transaction.category?.at(-1) || undefined
	);
}

export const createLinkToken = action({
	args: {},
	handler: async () => {
		const client = plaidClient();
		const redirectUri = env.PLAID_REDIRECT_URI;
		const response = await client.linkTokenCreate({
			user: {
				client_user_id: 'personal-money-tracker'
			},
			client_name: 'Personal Money Tracker',
			products: [Products.Transactions],
			country_codes: [CountryCode.Us],
			language: 'en',
			redirect_uri: redirectUri || undefined
		});

		return {
			linkToken: response.data.link_token,
			expiration: response.data.expiration,
			requestId: response.data.request_id,
			hasRedirectUri: Boolean(redirectUri)
		};
	}
});

export const exchangePublicToken = action({
	args: {
		publicToken: v.string(),
		institutionId: v.optional(v.string()),
		institutionName: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const client = plaidClient();
		const exchange = await client.itemPublicTokenExchange({
			public_token: args.publicToken
		});
		const plaidItemId: Id<'plaidItems'> = await ctx.runMutation(internal.plaid.storePlaidItem, {
			itemId: exchange.data.item_id,
			accessToken: exchange.data.access_token,
			institutionId: args.institutionId,
			institutionName: args.institutionName
		});

		const accounts = await client.accountsGet({
			access_token: exchange.data.access_token
		});

		await ctx.runMutation(internal.plaid.upsertAccounts, {
			plaidItemId,
			accounts: accounts.data.accounts.map((account) => ({
				accountId: account.account_id,
				name: account.name,
				officialName: account.official_name ?? undefined,
				mask: account.mask ?? undefined,
				type: account.type ?? undefined,
				subtype: account.subtype ?? undefined,
				currentBalance: account.balances.current ?? undefined,
				availableBalance: account.balances.available ?? undefined,
				isoCurrencyCode: account.balances.iso_currency_code ?? undefined
			}))
		});

		return {
			plaidItemId,
			itemId: exchange.data.item_id,
			accounts: accounts.data.accounts.length
		};
	}
});

export const syncAllItems = action({
	args: {},
	handler: async (ctx) => {
		const items: Array<{
			_id: Id<'plaidItems'>;
			accessToken: string;
			cursor?: string;
		}> = await ctx.runQuery(internal.plaid.listActiveItems, {});
		const results = [];

		for (const item of items) {
			const result = await syncItem(ctx, item);
			results.push(result);
		}

		return results;
	}
});

async function syncItem(
	ctx: ActionCtx,
	item: { _id: Id<'plaidItems'>; accessToken: string; cursor?: string }
) {
	const client = plaidClient();
	const syncRunId: Id<'syncRuns'> = await ctx.runMutation(internal.plaid.startSyncRun, {
		source: 'plaid'
	});
	let cursor = item.cursor;
	const added: Transaction[] = [];
	const modified: Transaction[] = [];
	const removed: RemovedTransaction[] = [];
	let hasMore = true;

	try {
		while (hasMore) {
			const response = await client.transactionsSync({
				access_token: item.accessToken,
				cursor,
				count: 500
			});

			added.push(...response.data.added);
			modified.push(...response.data.modified);
			removed.push(...response.data.removed);
			cursor = response.data.next_cursor;
			hasMore = response.data.has_more;
		}

		if (!cursor) {
			throw new Error('Plaid sync did not return a cursor.');
		}

		await ctx.runMutation(internal.plaid.applyTransactionSync, {
			plaidItemId: item._id,
			cursor,
			added: added.map(mapPlaidTransaction),
			modified: modified.map(mapPlaidTransaction),
			removed: removed.map((transaction) => ({
				transactionId: transaction.transaction_id,
				accountId: transaction.account_id
			}))
		});

		await ctx.runMutation(internal.plaid.finishSyncRun, {
			syncRunId,
			status: 'success',
			added: added.length,
			modified: modified.length,
			removed: removed.length
		});

		return {
			plaidItemId: item._id,
			added: added.length,
			modified: modified.length,
			removed: removed.length
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown Plaid sync error';
		await ctx.runMutation(internal.plaid.finishSyncRun, {
			syncRunId,
			status: 'error',
			errorMessage: message
		});
		throw error;
	}
}

function mapPlaidTransaction(transaction: Transaction): MappedPlaidTransaction {
	const displayName = transaction.merchant_name || transaction.name;

	return {
		transactionId: transaction.transaction_id,
		accountId: transaction.account_id,
		date: transaction.date,
		authorizedDate: transaction.authorized_date ?? undefined,
		name: transaction.name,
		merchantName: transaction.merchant_name ?? undefined,
		normalizedMerchant: normalizeMerchant(displayName),
		amount: transaction.amount,
		kind: transactionKind(transaction.amount),
		isoCurrencyCode: transaction.iso_currency_code ?? undefined,
		pending: transaction.pending,
		categoryPrimary: categoryPrimary(transaction),
		categoryDetailed: categoryDetailed(transaction)
	};
}
