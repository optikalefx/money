import { defineApp } from 'convex/server';
import { v } from 'convex/values';

export default defineApp({
	env: {
		PLAID_CLIENT_ID: v.string(),
		PLAID_SECRET: v.string(),
		PLAID_ENV: v.string(),
		PLAID_REDIRECT_URI: v.optional(v.string()),
		OPENAI_API_KEY: v.optional(v.string())
	}
});
