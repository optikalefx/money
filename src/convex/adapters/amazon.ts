import { env } from '../_generated/server';
import { collectBody, htmlToText } from './types';
import type { GmailMessage, ParsedItem, ParsedOrder, RetailerEmailAdapter } from './types';

const DEFAULT_AMAZON_QUERY =
	'from:(auto-confirm@amazon.com OR order-update@amazon.com) subject:(order OR ordered) newer_than:1y';

const ORDER_ID_PATTERN = /(\d{3}-\d{7}-\d{7})/g;
const AMOUNT = '\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:USD)?';

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

// The Amazon email adapter, built from the parser above. Its `sku` is the ASIN. The Gmail query
// honors the optional GMAIL_AMAZON_QUERY env override.
export const amazonAdapter: RetailerEmailAdapter = {
	merchant: 'amazon',
	gmailQuery: () => env.GMAIL_AMAZON_QUERY || DEFAULT_AMAZON_QUERY,
	merchantMatchers: ['amazon'],
	parseOrders: parseAmazonOrders
};
