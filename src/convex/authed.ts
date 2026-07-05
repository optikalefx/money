import {
	action,
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { customAction, customMutation, customQuery } from 'convex-helpers/server/customFunctions';

// Single-user app: any authenticated identity is the owner. A missing identity means the caller
// either never logged in or presented an expired/invalid token — reject before doing any work.
// The token itself is verified by Convex against the `customJwt` provider in `auth.config.ts`.
async function requireOwner(ctx: QueryCtx | MutationCtx | ActionCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error('Unauthorized');
}

// Drop-in replacements for the base `query`/`mutation`/`action` constructors. Function files alias
// these to the base names (`import { authedQuery as query }`) so every client-facing function is
// guarded with a one-line import change and no per-handler edits. Functions reachable only from the
// scheduler/server (which run with no user identity) must stay on the raw constructors or use an
// `internal*` sibling instead.
export const authedQuery = customQuery(query, {
	args: {},
	input: async (ctx) => {
		await requireOwner(ctx);
		return { ctx: {}, args: {} };
	}
});

export const authedMutation = customMutation(mutation, {
	args: {},
	input: async (ctx) => {
		await requireOwner(ctx);
		return { ctx: {}, args: {} };
	}
});

export const authedAction = customAction(action, {
	args: {},
	input: async (ctx) => {
		await requireOwner(ctx);
		return { ctx: {}, args: {} };
	}
});
