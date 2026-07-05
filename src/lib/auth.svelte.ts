import { PUBLIC_CONVEX_URL } from '$env/static/public';

// Owner auth for a single-user app. We log in once against the Convex `/auth/login` HTTP action,
// which returns a signed JWT; convex-svelte's `setupAuth` then attaches it to every request and
// the backend verifies it (see `src/convex/auth.config.ts`). The token lives in localStorage so a
// refresh keeps you signed in until it expires (~30 days).

const TOKEN_KEY = 'money_auth_token';
// HTTP actions are served from the `.convex.site` domain, not the `.convex.cloud` client API.
const siteUrl = PUBLIC_CONVEX_URL.replace('.convex.cloud', '.convex.site');

let token = $state<string | null>(null);
let ready = $state(false);

// Load any stored token. Runs on the client (no localStorage during SSR).
export function initAuth() {
	if (typeof localStorage !== 'undefined') {
		token = localStorage.getItem(TOKEN_KEY);
	}
	ready = true;
}

// Reactive provider consumed by convex-svelte's `setupAuth`. When `token` changes, the getter
// re-runs and convex-svelte re-attaches (or clears) auth on the client.
export function authProvider() {
	return {
		isLoading: !ready,
		isAuthenticated: token !== null,
		fetchAccessToken: async () => token
	};
}

export async function login(password: string): Promise<void> {
	const res = await fetch(`${siteUrl}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password })
	});
	if (!res.ok) {
		const detail = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(detail.error ?? 'Login failed.');
	}
	const data = (await res.json()) as { token: string };
	token = data.token;
	if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_KEY, token);
}

export function logout() {
	token = null;
	if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
}
