<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		actions,
		children
	}: {
		eyebrow: string;
		title: string;
		actions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="section-panel organic-surface">
	<div class="section-heading">
		<div>
			<p class="eyebrow">{eyebrow}</p>
			<h2>{title}</h2>
		</div>
		{#if actions}
			<div class="section-heading-actions">{@render actions()}</div>
		{/if}
	</div>
	{@render children()}
</section>

<style>
	.section-panel {
		margin-bottom: 1.25rem;
		padding: 1.5rem;
		border-radius: 2rem 3.5rem 2rem 2.75rem;
	}

	.section-heading {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}

	.eyebrow {
		display: block;
		margin-bottom: 0.5rem;
		color: var(--color-primary);
		font-size: 0.78rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.section-heading h2 {
		margin: 0.25rem 0 0;
		font-size: clamp(1.3rem, 3vw, 1.8rem);
	}
</style>
