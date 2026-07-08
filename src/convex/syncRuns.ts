import { v } from 'convex/values';
import { authedQuery as query } from './authed';

// Recent sync activity across all sources (plaid / gmail / ai), newest first — the audit trail
// behind "when did each service last update and how much came in". Bounded take on the built-in
// _creationTime order, so the read stays small no matter how large the table grows.
export const listRecent = query({
	args: { limit: v.optional(v.number()) },
	returns: v.array(
		v.object({
			_id: v.id('syncRuns'),
			_creationTime: v.number(),
			source: v.union(v.literal('plaid'), v.literal('gmail'), v.literal('ai')),
			status: v.union(v.literal('running'), v.literal('success'), v.literal('error')),
			startedAt: v.number(),
			finishedAt: v.optional(v.number()),
			added: v.optional(v.number()),
			modified: v.optional(v.number()),
			removed: v.optional(v.number()),
			errorCode: v.optional(v.string()),
			errorMessage: v.optional(v.string())
		})
	),
	handler: async (ctx, args) => {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
		return await ctx.db.query('syncRuns').order('desc').take(limit);
	}
});
