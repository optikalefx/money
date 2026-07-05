import { defineApp } from 'convex/server';
import { v } from 'convex/values';

export default defineApp({
	env: {
		PLAID_CLIENT_ID: v.string(),
		PLAID_SECRET: v.string(),
		PLAID_ENV: v.string(),
		PLAID_REDIRECT_URI: v.optional(v.string()),
		OPENAI_API_KEY: v.optional(v.string()),
		GOOGLE_CLIENT_ID: v.optional(v.string()),
		GOOGLE_CLIENT_SECRET: v.optional(v.string()),
		GOOGLE_REDIRECT_URI: v.optional(v.string()),
		// Optional overrides. Defaults are applied in gmailActions.ts.
		GMAIL_AMAZON_QUERY: v.optional(v.string()),
		GMAIL_POST_AUTH_URL: v.optional(v.string()),
		// Owner auth. Set via `npm run auth:setup` (see README). Optional so the deployment can be
		// pushed before auth is provisioned; the login/JWKS routes return errors until they exist.
		OWNER_PASSWORD: v.optional(v.string()),
		JWT_PRIVATE_KEY: v.optional(v.string()),
		JWKS: v.optional(v.string())
	}
});
