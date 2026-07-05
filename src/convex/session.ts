import { query } from './_generated/server';

// Intentionally NOT guarded: the client calls this to decide whether to show the login gate.
// Returns only a boolean, never any data.
export const status = query({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		return { authenticated: identity !== null };
	}
});
