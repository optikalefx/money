<script lang="ts">
	import { useQuery } from 'convex-svelte';
	import { api } from '../convex/_generated/api.js';
	import Modal from '$lib/Modal.svelte';

	let {
		open = false,
		onClose
	}: {
		/** Controls visibility; the history query only subscribes while open. */
		open?: boolean;
		/** Called whenever the dialog closes (backdrop click, Escape, or the ✕). */
		onClose?: () => void;
	} = $props();

	// Skipped (unsubscribed) until the dialog opens, so the history loads on-open and costs
	// nothing while closed.
	const syncRuns = useQuery(api.syncRuns.listRecent, () => (open ? { limit: 25 } : 'skip'));

	function formatDate(timestamp: number) {
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(timestamp));
	}

	function summary(run: { source: string; added?: number; modified?: number; removed?: number }) {
		if (run.source === 'gmail') return `${run.added ?? 0} orders imported`;
		const parts = [`${run.added ?? 0} added`];
		if (run.modified) parts.push(`${run.modified} modified`);
		if (run.removed) parts.push(`${run.removed} removed`);
		return parts.join(', ');
	}
</script>

<Modal {open} title="Sync history" {onClose}>
	{#if syncRuns.isLoading}
		<p class="history-note">Loading history…</p>
	{:else if syncRuns.data?.length}
		<ul class="history-list">
			{#each syncRuns.data as run (run._id)}
				<li class="history-row" class:history-error={run.status === 'error'}>
					<span class="history-source">{run.source}</span>
					<span class="history-when">{formatDate(run.startedAt)}</span>
					<span class="history-detail">
						{#if run.status === 'running'}
							running…
						{:else if run.status === 'error'}
							failed{run.errorMessage ? ` — ${run.errorMessage}` : ''}
						{:else}
							{summary(run)}
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="history-note">No syncs recorded yet.</p>
	{/if}
</Modal>

<style>
	.history-note {
		margin: 0;
		color: var(--color-muted-foreground);
	}

	.history-list {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.history-row {
		display: grid;
		grid-template-columns: 4rem 8.5rem minmax(0, 1fr);
		gap: 0.5rem;
		align-items: baseline;
		font-size: 0.85rem;
	}

	.history-source {
		color: var(--color-muted-foreground);
		font-weight: 800;
		text-transform: capitalize;
	}

	.history-when {
		color: var(--color-muted-foreground);
	}

	.history-detail {
		color: var(--color-foreground);
		overflow-wrap: anywhere;
	}

	.history-error .history-detail {
		color: var(--color-destructive);
	}
</style>
