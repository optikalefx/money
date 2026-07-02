import { v } from 'convex/values';
import { action, env, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DEFAULT_AMAZON_QUERY =
	'from:(auto-confirm@amazon.com OR order-update@amazon.com) subject:(order OR ordered) newer_than:1y';
const MAX_MESSAGE_PAGES = 10;

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
				const messageIds = await listMessageIds(accessToken, adapterQuery(adapter));
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
								title: item.title,
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

type GmailPart = {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPart[];
};

type GmailMessage = {
	id: string;
	snippet?: string;
	internalDate?: string;
	payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
};

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

function decodeBase64Url(data: string): string {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function collectBody(part: GmailPart | undefined, mimeType: string): string {
	if (!part) return '';
	if (part.mimeType === mimeType && part.body?.data) {
		return decodeBase64Url(part.body.data);
	}
	let result = '';
	for (const child of part.parts ?? []) {
		result += collectBody(child, mimeType);
	}
	return result;
}

function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/\s+/g, ' ')
		.trim();
}

const ORDER_ID_PATTERN = /(\d{3}-\d{7}-\d{7})/g;

type ParsedItem = { title: string; quantity?: number; amount?: number; sku?: string };
type ParsedOrder = { orderId: string; total?: number; items: ParsedItem[] };

// A per-retailer email adapter. Amazon is the first; new stores add another adapter and nothing
// else in the pipeline changes. `merchantMatchers` are the merchant-name patterns used to match a
// parsed order to a Plaid charge.
type RetailerEmailAdapter = {
	merchant: string;
	gmailQuery: string;
	merchantMatchers: string[];
	parseOrders: (message: GmailMessage) => ParsedOrder[];
};

// Each item's product link is a /gp/r.html redirect whose (URL-encoded) target is
// .../dp/<ASIN>?ref_=..._i_fed_asin_title. There's exactly one title link per item, in order.
// Match both the encoded and decoded forms directly rather than decoding the whole 160KB body
// (decodeURIComponent throws on the stray % sequences Amazon leaves in the markup).
function extractAsins(html: string): string[] {
	if (!html) return [];
	const asins: string[] = [];
	const pattern =
		/(?:\/dp\/|%2Fdp%2F)([A-Z0-9]{10})(?:\?ref_=|%3Fref_%3D)[^"'&]*?_i_fed_asin_title/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		asins.push(match[1]);
	}
	return asins;
}

// Amazon "auto-confirm" emails bundle one or more orders. The text/plain part lays each order out as:
//   Order #
//   NNN-NNNNNNN-NNNNNNN
//   * <item title>
//     Quantity: N
//     NN.NN USD
//   Grand Total:
//   NN.NN USD
// We split the body on order numbers and parse each order block independently.
function parseAmazonOrders(message: GmailMessage): ParsedOrder[] {
	const plain = collectBody(message.payload, 'text/plain');
	const html = collectBody(message.payload, 'text/html');
	const source = plain || htmlToText(html);
	if (!source) return [];

	// Boundaries are the first occurrence of each distinct order number (it repeats in links).
	const boundaries: Array<{ orderId: string; index: number }> = [];
	const seen = new Set<string>();
	for (const match of source.matchAll(ORDER_ID_PATTERN)) {
		const orderId = match[1];
		if (seen.has(orderId)) continue;
		seen.add(orderId);
		boundaries.push({ orderId, index: match.index ?? 0 });
	}

	const orders = boundaries.map((boundary, i) => {
		const end = i + 1 < boundaries.length ? boundaries[i + 1].index : source.length;
		const block = source.slice(boundary.index, end);
		return {
			orderId: boundary.orderId,
			total: parseTotal(block),
			items: parseItems(block)
		};
	});

	// ASINs come from the HTML in the same order as the plain-text items. Only assign when the
	// counts line up exactly, so a template quirk can never mis-attribute an ASIN to the wrong item.
	const asins = extractAsins(html);
	const flatItems = orders.flatMap((order) => order.items);
	if (asins.length === flatItems.length) {
		flatItems.forEach((item, i) => {
			item.sku = asins[i];
		});
	}

	return orders;
}

// The Amazon email adapter, built from the parser above. Its `sku` is the ASIN.
const amazonAdapter: RetailerEmailAdapter = {
	merchant: 'amazon',
	gmailQuery: DEFAULT_AMAZON_QUERY,
	merchantMatchers: ['amazon'],
	parseOrders: parseAmazonOrders
};

// Registry of retailer adapters. Add a new store's adapter here to start importing its orders.
const RETAILER_ADAPTERS: RetailerEmailAdapter[] = [amazonAdapter];

// Per-adapter Gmail search query, honoring the optional Amazon env override.
function adapterQuery(adapter: RetailerEmailAdapter): string {
	if (adapter.merchant === 'amazon') return env.GMAIL_AMAZON_QUERY || adapter.gmailQuery;
	return adapter.gmailQuery;
}

const AMOUNT = '\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:USD)?';

// Total wording varies by template: "Grand Total:", "Order Total: $X", or a bare "Total" line.
// The net card charge (after gift cards/promos) is what should match a Plaid transaction.
function parseTotal(block: string): number | undefined {
	const labelled = [
		new RegExp(`Grand Total:\\s*${AMOUNT}`, 'i'),
		new RegExp(`Order Total:\\s*${AMOUNT}`, 'i')
	];
	for (const pattern of labelled) {
		const match = block.match(pattern);
		if (match) return Number(match[1].replace(/,/g, ''));
	}
	// Bare "Total" as its own line (avoids matching "Subtotal"/"Grand Total"), amount may be on the next line.
	const bare = block.match(
		new RegExp(`(?:^|\\n)[ \\t]*Total[ \\t]*:?[ \\t]*(?:\\r?\\n)?[ \\t]*${AMOUNT}`, 'i')
	);
	return bare ? Number(bare[1].replace(/,/g, '')) : undefined;
}

function parseAmount(line: string): number | undefined {
	const match =
		line.match(/^([0-9][0-9,]*\.[0-9]{1,2})\s*USD$/i) ||
		line.match(/^\$\s*([0-9][0-9,]*\.[0-9]{2})$/);
	return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function parseItems(block: string): ParsedItem[] {
	const items: ParsedItem[] = [];
	let current: ParsedItem | null = null;
	const push = () => {
		if (current && current.title) items.push(current);
		current = null;
	};

	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trim();
		const itemStart = line.match(/^\*\s+(.+)/);
		if (itemStart) {
			push();
			current = { title: itemStart[1].trim() };
			continue;
		}
		if (/^Grand Total:/i.test(line)) {
			push();
			continue;
		}
		if (!current) continue;

		const quantity = line.match(/^Quantity:\s*(\d+)/i);
		if (quantity) {
			current.quantity = Number(quantity[1]);
			continue;
		}
		const amount = parseAmount(line);
		if (amount !== undefined && current.amount === undefined) {
			current.amount = amount;
		}
	}
	push();
	return items;
}
