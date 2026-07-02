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
	handler: async (ctx) => {
		const cleared: Record<string, number> = {};
		for (const table of DATA_TABLES) {
			let count = 0;
			// Delete in bounded batches to stay within a single transaction's limits.
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
});
