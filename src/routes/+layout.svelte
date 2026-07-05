<script lang="ts">
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import { setupConvex, setupAuth, useAuth } from 'convex-svelte';
	import { authProvider, initAuth } from '$lib/auth.svelte';
	import Login from '$lib/Login.svelte';
	import '../app.css';

	const { children } = $props();
	setupConvex(PUBLIC_CONVEX_URL);
	initAuth();
	setupAuth(() => authProvider());

	const auth = useAuth();
</script>

{#if auth.isLoading}
	<div class="auth-splash"></div>
{:else if auth.isAuthenticated}
	{@render children()}
{:else}
	<Login />
{/if}

<style>
	.auth-splash {
		min-height: 100vh;
		background: #f7f4ee;
	}
</style>
