<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'primary',
		type = 'button',
		disabled = false,
		loading = false,
		loadingLabel,
		onclick,
		class: className = '',
		children
	}: {
		variant?: 'primary' | 'outline';
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		loading?: boolean;
		/** Optional label shown in place of the children while loading. */
		loadingLabel?: string;
		onclick?: (event: MouseEvent) => void;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<button
	class="button loading-button {variant === 'primary'
		? 'button-primary'
		: 'button-outline'} {className}"
	class:is-loading={loading}
	{type}
	disabled={disabled || loading}
	aria-busy={loading}
	{onclick}
>
	{#if loading}
		<span class="button-shimmer" aria-hidden="true"></span>
		<span class="button-spinner" aria-hidden="true"></span>
	{/if}
	<span class="button-label">
		{#if loading && loadingLabel}{loadingLabel}{:else}{@render children()}{/if}
	</span>
</button>

<style>
	/* Positioning context for the shimmer sweep; clip it to the pill shape. */
	.loading-button {
		position: relative;
		overflow: hidden;
	}

	.button-label {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.is-loading {
		cursor: progress;
	}

	/* Hold the button still while it works — no hover/press scaling mid-load. */
	.loading-button.is-loading:hover,
	.loading-button.is-loading:active {
		transform: none;
	}

	.button-spinner {
		position: relative;
		z-index: 1;
		width: 1.05rem;
		height: 1.05rem;
		flex-shrink: 0;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		opacity: 0.9;
		animation: button-spin 0.7s linear infinite;
	}

	/* Soft light sweep travelling across the surface while loading. */
	.button-shimmer {
		position: absolute;
		inset: 0;
		z-index: 0;
		background: linear-gradient(
			100deg,
			transparent 25%,
			rgb(255 255 255 / 38%) 50%,
			transparent 75%
		);
		transform: translateX(-100%);
		animation: button-sweep 1.25s ease-in-out infinite;
	}

	@keyframes button-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes button-sweep {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(100%);
		}
	}
</style>
