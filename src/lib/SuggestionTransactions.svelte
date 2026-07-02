<script lang="ts">
	import { useQuery } from 'convex-svelte';
	import { api } from '../convex/_generated/api.js';
	import type { Id } from '../convex/_generated/dataModel.js';

	let { id }: { id: Id<'categorySuggestions'> } = $props();

	const txns = useQuery(api.categories.getSuggestionTransactions, () => ({ id }));
	const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

	function formatAmount(amount: number | null) {
		return amount === null ? '—' : currency.format(amount);
	}

	function statusLabel(status: 'recurring' | 'expected' | 'transfer' | null) {
		if (status === 'recurring') return 'Recurring';
		if (status === 'expected') return 'Expected';
		if (status === 'transfer') return 'Transfer';
		return '';
	}
</script>

<div class="txn-panel">
	{#if txns.isLoading}
		<p class="txn-empty">Loading transactions...</p>
	{:else if txns.data && txns.data.length}
		<div class="txn-head">
			<span class="txn-date">Date</span>
			<span class="txn-name">Transaction</span>
			<span class="txn-merchant">Merchant</span>
			<span class="txn-status">Status</span>
			<span class="txn-amount">Amount</span>
		</div>
		<ul class="txn-list">
			{#each txns.data as txn, i (i)}
				<li class="txn-row">
					<span class="txn-date">{txn.date || '—'}</span>
					<span class="txn-name">{txn.name}</span>
					<span class="txn-merchant">{txn.merchant}</span>
					<span class="txn-status">
						{#if txn.status}
							<span class="status-chip status-{txn.status}">{statusLabel(txn.status)}</span>
						{/if}
					</span>
					<span class="txn-amount">{formatAmount(txn.amount)}</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="txn-empty">No transactions found.</p>
	{/if}
</div>

<style>
	.txn-panel {
		margin-top: 0.85rem;
		padding-top: 0.85rem;
		border-top: 1px solid rgb(222 216 207 / 70%);
	}

	.txn-head {
		display: grid;
		grid-template-columns: 6rem minmax(0, 2fr) minmax(0, 1fr) 6rem 6rem;
		gap: 0.75rem;
		padding: 0 0 0.35rem;
		border-bottom: 1px solid rgb(222 216 207 / 70%);
		color: var(--color-muted-foreground);
		font-size: 0.72rem;
		font-weight: 900;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.txn-head .txn-amount {
		text-align: right;
	}

	.txn-list {
		display: grid;
		gap: 0.15rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.txn-row {
		display: grid;
		grid-template-columns: 6rem minmax(0, 2fr) minmax(0, 1fr) 6rem 6rem;
		gap: 0.75rem;
		align-items: center;
		padding: 0.3rem 0;
		border-bottom: 1px solid rgb(222 216 207 / 40%);
		font-size: 0.85rem;
	}

	.txn-row:last-child {
		border-bottom: 0;
	}

	.txn-date {
		color: var(--color-muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.txn-name {
		overflow: hidden;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.txn-merchant {
		overflow: hidden;
		color: var(--color-muted-foreground);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.txn-amount {
		font-weight: 800;
		text-align: right;
		white-space: nowrap;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		padding: 0.15rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: 0.72rem;
		font-weight: 800;
		line-height: 1.2;
		white-space: nowrap;
	}

	.status-recurring {
		color: var(--color-primary);
		background: rgb(93 112 82 / 14%);
	}

	.status-expected {
		color: var(--color-secondary);
		background: rgb(193 140 93 / 16%);
	}

	.status-transfer {
		color: var(--color-muted-foreground);
		background: rgb(82 76 68 / 12%);
	}

	.txn-empty {
		margin: 0;
		color: var(--color-muted-foreground);
		font-size: 0.85rem;
	}

	@media (max-width: 640px) {
		.txn-head {
			display: none;
		}

		.txn-row {
			grid-template-columns: 1fr auto;
			row-gap: 0.1rem;
		}

		.txn-date,
		.txn-merchant,
		.txn-status {
			grid-column: 1;
		}

		.txn-amount {
			grid-row: 1;
			grid-column: 2;
		}
	}
</style>
