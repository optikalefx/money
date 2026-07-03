import { v } from 'convex/values';
import { action, env, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { RETAILER_ADAPTERS, type GmailMessage } from './adapters';
import { faker } from '@faker-js/faker/locale/en';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_MESSAGE_PAGES = 10;

// Stable 32-bit hash so a given key always seeds Faker the same way.
function hashKey(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

// When FAKE_PRODUCT_NAMES is enabled we replace the real order item title with a fake product
// name, so a non-production deployment (e.g. testing against a real Gmail inbox) never stores or
// displays what was actually purchased. Seeded by sku (falling back to the real title) so the same
// product always maps to the same fake name across imports — keeping display stable and the
// `(merchant, sku)` category cache meaningful. Off by default: production simply doesn't set the
// var, so real titles are preserved.
function displayTitle(realTitle: string, sku?: string): string {
	const envVars = env as unknown as Record<string, string | undefined>;
	if (envVars.FAKE_PRODUCT_NAMES !== 'true') return realTitle;
	faker.seed(hashKey(sku ?? realTitle));
	return faker.commerce.productName();
}

function requireGoogleConfig() {
	const clientId = env.GOOGLE_CLIENT_ID;
	const clientSecret = env.GOOGLE_CLIENT_SECRET;
	const redirectUri = env.GOOGLE_REDIRECT_URI;

	if (!clientId || !clientSecret || !redirectUri) {
		throw new Error(
			'Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Convex.'
		);
	}

	return { clientId, clientSecret, redirectUri };
}

export const getGmailAuthUrl = action({
	args: { returnTo: v.optional(v.string()) },
	handler: async (ctx, args): Promise<{ url: string }> => {
		const { clientId, redirectUri } = requireGoogleConfig();
		const state: string = await ctx.runMutation(internal.gmail.createOAuthState, {
			returnTo: args.returnTo
		});
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: GMAIL_SCOPE,
			access_type: 'offline',
			// Force a consent prompt so Google always returns a refresh token.
			prompt: 'consent',
			include_granted_scopes: 'true',
			state
		});

		return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
	}
});

export const syncGmail = action({
	args: {},
	handler: async (ctx) => {
		const account: {
			_id: Id<'gmailAccounts'>;
			refreshToken: string;
			lastMessageEpochMs?: number;
		} | null = await ctx.runQuery(internal.gmail.getGmailAccount, {});

		if (!account) {
			throw new Error('Gmail is not connected.');
		}

		const syncRunId: Id<'syncRuns'> = await ctx.runMutation(internal.plaid.startSyncRun, {
			source: 'gmail'
		});

		try {
			const accessToken = await refreshAccessToken(ctx, account._id, account.refreshToken);

			let added = 0;
			let scanned = 0;
			let maxEpoch = account.lastMessageEpochMs ?? 0;

			// Run each retailer adapter over its own Gmail search, importing store-agnostic orders.
			for (const adapter of RETAILER_ADAPTERS) {
				const messageIds = await listMessageIds(accessToken, adapter.gmailQuery());
				scanned += messageIds.length;

				for (const messageId of messageIds) {
					const message = await getMessage(accessToken, messageId);
					const epoch = Number(message.internalDate ?? 0);
					if (account.lastMessageEpochMs && epoch <= account.lastMessageEpochMs) continue;
					if (epoch > maxEpoch) maxEpoch = epoch;

					// A single email can bundle multiple orders, each its own card charge.
					const orderDate = epoch > 0 ? new Date(epoch).toISOString().slice(0, 10) : undefined;
					for (const order of adapter.parseOrders(message)) {
						await ctx.runMutation(internal.gmail.upsertOrder, {
							source: 'gmail',
							merchant: adapter.merchant,
							sourceMessageId: message.id,
							orderId: order.orderId,
							orderDate,
							total: order.total,
							isoCurrencyCode: 'USD',
							items: order.items.map((item) => ({
								title: displayTitle(item.title, item.sku),
								quantity: item.quantity,
								amount: item.amount,
								sku: item.sku
							})),
							merchantMatchers: adapter.merchantMatchers,
							raw: { snippet: message.snippet, orderId: order.orderId }
						});
						added += 1;
					}
				}
			}

			await ctx.runMutation(internal.gmail.finishGmailSync, {
				accountId: account._id,
				lastMessageEpochMs: maxEpoch > 0 ? maxEpoch : undefined
			});
			await ctx.runMutation(internal.plaid.finishSyncRun, {
				syncRunId,
				status: 'success',
				added
			});

			// Newly imported order items land in Uncategorized until the AI categorizer runs. Chain it
			// (same as the Plaid sync) so a Gmail import always categorizes new items — it only calls
			// the model for `(merchant, sku)` pairs not already cached, so a no-op import is cheap.
			if (added > 0) {
				await ctx.scheduler.runAfter(0, api.aiActions.categorizeTransactions, {});
			}

			return { scanned, imported: added };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown Gmail sync error';
			await ctx.runMutation(internal.gmail.markGmailError, {
				accountId: account._id,
				status: 'error',
				errorMessage: message
			});
			await ctx.runMutation(internal.plaid.finishSyncRun, {
				syncRunId,
				status: 'error',
				errorMessage: message
			});
			throw error;
		}
	}
});

async function refreshAccessToken(
	ctx: ActionCtx,
	accountId: Id<'gmailAccounts'>,
	refreshToken: string
): Promise<string> {
	const { clientId, clientSecret } = requireGoogleConfig();
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		})
	});

	if (!response.ok) {
		const detail = await response.text();
		if (response.status === 400 || response.status === 401) {
			await ctx.runMutation(internal.gmail.markGmailError, {
				accountId,
				status: 'needs_reconnect',
				errorMessage: 'Gmail authorization expired. Reconnect required.'
			});
		}
		throw new Error(`Failed to refresh Gmail token: ${detail.slice(0, 200)}`);
	}

	const token = (await response.json()) as { access_token: string; expires_in?: number };
	await ctx.runMutation(internal.gmail.updateAccessToken, {
		accountId,
		accessToken: token.access_token,
		accessTokenExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000
	});
	return token.access_token;
}

async function listMessageIds(accessToken: string, query: string): Promise<string[]> {
	const ids: string[] = [];
	let pageToken: string | undefined;

	for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
		const params = new URLSearchParams({ q: query, maxResults: '100' });
		if (pageToken) params.set('pageToken', pageToken);

		const response = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
			{ headers: { authorization: `Bearer ${accessToken}` } }
		);
		if (!response.ok) {
			throw new Error(`Gmail message list failed: ${(await response.text()).slice(0, 200)}`);
		}

		const data = (await response.json()) as {
			messages?: Array<{ id: string }>;
			nextPageToken?: string;
		};
		for (const message of data.messages ?? []) ids.push(message.id);
		if (!data.nextPageToken) break;
		pageToken = data.nextPageToken;
	}

	return ids;
}

async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
	const response = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
		{ headers: { authorization: `Bearer ${accessToken}` } }
	);
	if (!response.ok) {
		throw new Error(`Gmail message fetch failed: ${(await response.text()).slice(0, 200)}`);
	}
	return (await response.json()) as GmailMessage;
}
