import { httpRouter } from 'convex/server';
import { httpAction, env } from './_generated/server';
import { internal } from './_generated/api';

const http = httpRouter();

function page(title: string, body: string, status = 200) {
	const backUrl = env.GMAIL_POST_AUTH_URL || '/';
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
			`<meta name="viewport" content="width=device-width, initial-scale=1">` +
			`<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;` +
			`min-height:100vh;background:#f7f4ee;color:#2f2b25}main{max-width:28rem;padding:2rem;text-align:center}` +
			`a{color:#5d7052;font-weight:700}</style></head><body><main>` +
			`<h1>${title}</h1><p>${body}</p><p><a href="${backUrl}">Return to Money Tracker</a></p>` +
			`</main></body></html>`,
		{ status, headers: { 'content-type': 'text/html; charset=utf-8' } }
	);
}

http.route({
	path: '/gmail/callback',
	method: 'GET',
	handler: httpAction(async (ctx, request) => {
		const url = new URL(request.url);
		const error = url.searchParams.get('error');
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');

		if (error) {
			return page('Gmail connection cancelled', `Google returned: ${error}.`, 400);
		}
		if (!code || !state) {
			return page('Gmail connection failed', 'Missing authorization code or state.', 400);
		}

		const stateResult: { valid: boolean; returnTo: string | null } = await ctx.runMutation(
			internal.gmail.consumeOAuthState,
			{ state }
		);
		if (!stateResult.valid) {
			return page('Gmail connection failed', 'The sign-in request expired. Please try again.', 400);
		}

		const clientId = env.GOOGLE_CLIENT_ID;
		const clientSecret = env.GOOGLE_CLIENT_SECRET;
		const redirectUri = env.GOOGLE_REDIRECT_URI;
		if (!clientId || !clientSecret || !redirectUri) {
			return page(
				'Gmail is not configured',
				'Google OAuth environment variables are missing.',
				500
			);
		}

		const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code'
			})
		});

		if (!tokenResponse.ok) {
			const detail = await tokenResponse.text();
			return page('Gmail connection failed', `Token exchange failed: ${detail.slice(0, 300)}`, 502);
		}

		const token = (await tokenResponse.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			scope?: string;
		};

		if (!token.refresh_token) {
			return page(
				'Gmail connection incomplete',
				'Google did not return a refresh token. Remove this app from your Google account permissions and connect again to force a fresh consent.',
				400
			);
		}

		let email: string | undefined;
		if (token.access_token) {
			const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
				headers: { authorization: `Bearer ${token.access_token}` }
			});
			if (profile.ok) {
				email = ((await profile.json()) as { emailAddress?: string }).emailAddress;
			}
		}

		await ctx.runMutation(internal.gmail.storeGmailToken, {
			refreshToken: token.refresh_token,
			accessToken: token.access_token,
			accessTokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
			scope: token.scope,
			email
		});

		const returnTo = safeReturnTo(stateResult.returnTo) ?? safeReturnTo(env.GMAIL_POST_AUTH_URL);
		if (returnTo) {
			const target = new URL(returnTo);
			target.searchParams.set('gmail', 'connected');
			return Response.redirect(target.toString(), 302);
		}

		return page(
			'Gmail connected',
			`${email ?? 'Your account'} is now linked. You can sync Amazon orders.`
		);
	})
});

// Only allow http(s) absolute URLs as post-auth redirect targets (guards against open redirect).
function safeReturnTo(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
	} catch {
		return null;
	}
	return null;
}

export default http;
