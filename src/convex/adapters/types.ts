// Shared types and Gmail message helpers used by every retailer email adapter.

export type GmailPart = {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPart[];
};

export type GmailMessage = {
	id: string;
	snippet?: string;
	internalDate?: string;
	payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
};

export type ParsedItem = { title: string; quantity?: number; amount?: number; sku?: string };
export type ParsedOrder = { orderId: string; total?: number; items: ParsedItem[] };

// A per-retailer email adapter. Add a new store by writing another adapter; nothing else in the
// pipeline changes. `merchantMatchers` are the merchant-name patterns used to match a parsed order
// to a Plaid charge. `gmailQuery` is resolved lazily so an adapter can honor env overrides.
export type RetailerEmailAdapter = {
	merchant: string;
	gmailQuery: () => string;
	merchantMatchers: string[];
	parseOrders: (message: GmailMessage) => ParsedOrder[];
};

function decodeBase64Url(data: string): string {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

// Recursively concatenate every body part matching `mimeType` (e.g. 'text/plain', 'text/html').
export function collectBody(part: GmailPart | undefined, mimeType: string): string {
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

export function htmlToText(html: string): string {
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
