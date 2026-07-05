<script lang="ts">
	import { login } from '$lib/auth.svelte';

	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(event: Event) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			await login(password);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Login failed.';
		} finally {
			busy = false;
		}
	}
</script>

<main class="login">
	<form onsubmit={submit}>
		<h1>Money Tracker</h1>
		<p>Enter the owner password to continue.</p>
		<input
			type="password"
			bind:value={password}
			placeholder="Password"
			autocomplete="current-password"
		/>
		<button type="submit" disabled={busy || password.length === 0}>
			{busy ? 'Signing in…' : 'Sign in'}
		</button>
		{#if error}<p class="error">{error}</p>{/if}
	</form>
</main>

<style>
	.login {
		min-height: 100vh;
		display: grid;
		place-items: center;
		background: #f7f4ee;
		color: #2f2b25;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: min(20rem, 90vw);
		padding: 2rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	p {
		margin: 0;
		color: #6b6455;
		font-size: 0.9rem;
	}
	input {
		padding: 0.6rem 0.75rem;
		border: 1px solid #d8d2c4;
		border-radius: 0.5rem;
		font-size: 1rem;
	}
	button {
		padding: 0.6rem 0.75rem;
		border: none;
		border-radius: 0.5rem;
		background: #5d7052;
		color: white;
		font-weight: 700;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.error {
		color: #b4442f;
		font-size: 0.9rem;
	}
</style>
