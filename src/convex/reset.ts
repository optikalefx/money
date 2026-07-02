import { internalMutation } from './_generated/server';
import type { TableNames } from './_generated/dataModel';

// Data tables to wipe on a fresh start. Connection/account tables (`plaidItems`, `accounts`,
// `gmailAccounts`) and `appConfig` are intentionally preserved so re-syncing works.
const DATA_TABLES: TableNames[] = [
	'transactions',
	'orders',
	'orderItems',
	'itemRules',
	'itemCategories',
	'merchantCategories',
	'merchantRules',
	'aiRuns',
	'categorySuggestions',
	'syncRuns',
	'categories',
	'oauthStates'
];

// Connection tables, wiped only by `clearEverything` (not the data-only `clearAllData`) so you
// can re-link from scratch — needed when switching Plaid environments, since access tokens and
// sync cursors are environment-specific and stored on these rows.
const CONNECTION_TABLES: TableNames[] = ['plaidItems', 'accounts', 'gmailAccounts'];

// Delete every row in the given tables, in bounded batches to stay within transaction limits.
async function wipeTables(
	ctx: { db: { query: (t: TableNames) => any; delete: (id: any) => Promise<void> } },
	tables: TableNames[]
) {
	const cleared: Record<string, number> = {};
	for (const table of tables) {
		let count = 0;
		for (let batch = 0; batch < 50; batch++) {
			const rows = await ctx.db.query(table).take(200);
			if (rows.length === 0) break;
			for (const row of rows) await ctx.db.delete(row._id);
			count += rows.length;
			if (rows.length < 200) break;
		}
		cleared[table] = count;
	}
	return cleared;
}

// Reset the sync cursors so a fresh re-import pulls full history: Plaid `transactionsSync` and the
// Gmail scan both resume from a saved position, which would skip everything after a data wipe.
export const resetSyncCursors = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		let plaidItems = 0;
		for (const item of await ctx.db.query('plaidItems').take(100)) {
			await ctx.db.patch(item._id, { cursor: undefined, lastSyncAt: undefined, updatedAt: now });
			plaidItems += 1;
		}
		let gmailAccounts = 0;
		for (const account of await ctx.db.query('gmailAccounts').take(100)) {
			await ctx.db.patch(account._id, { lastMessageEpochMs: undefined, updatedAt: now });
			gmailAccounts += 1;
		}
		return { plaidItems, gmailAccounts };
	}
});

// One-shot reset: delete all order/transaction/category data, keeping Plaid + Gmail connections.
// Run with `npx convex run reset:clearAllData` before pushing the new schema, then re-sync.
export const clearAllData = internalMutation({
	args: {},
	handler: async (ctx) => wipeTables(ctx, DATA_TABLES)
});

// Full wipe to test onboarding from zero: everything `clearAllData` removes PLUS the linked Plaid
// items, accounts, and Gmail connections, so the app returns to its "nothing connected" state.
// Use when switching Plaid environments (e.g. production -> sandbox), since the old access tokens
// are environment-specific and won't work. Run with `npx convex run reset:clearEverything`, then
// re-link accounts in the app. `appConfig` is left alone (it re-seeds on boot).
export const clearEverything = internalMutation({
	args: {},
	handler: async (ctx) => wipeTables(ctx, [...DATA_TABLES, ...CONNECTION_TABLES])
});
