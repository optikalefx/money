<script lang="ts">
	import { useMutation, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api.js';
	import type { Id } from '../../convex/_generated/dataModel.js';
	import { tooltip, truncateWords } from '$lib/tooltip';

	type RecurringRow = {
		id: Id<'transactions'>;
		date: string;
		name: string;
		merchantName: string | null;
		amount: number;
		kind: 'expense' | 'income' | 'transfer';
		pending: boolean;
		categoryPrimary: string | null;
		categoryDetailed: string | null;
		userCategory: string | null;
		classificationSource: string;
		source: string;
		amazonItems?: Array<{ title: string; quantity: number | null; amount: number | null }>;
	};
	type MerchantRow = {
		key: string;
		asin: string | null;
		normalizedMerchant: string;
		label: string;
		total: number;
		count: number;
		monthly: number;
	};

	const today = new Date();
	const initialMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

	let selectedMonth = $state(initialMonth);
	let allTime = $state(false);
	let unmarkingKey = $state<string | null>(null);
	let statusMessage = $state('');
	let errorMessage = $state('');

	const monthStart = $derived(`${selectedMonth}-01`);
	const monthEnd = $derived(lastDayOfMonth(selectedMonth));
	const tableArgs = $derived(allTime ? {} : { startDate: monthStart, endDate: monthEnd });

	// Summary (category + merchant totals) is always all-time — it is not affected by the date filter.
	const summary = useQuery(api.plaid.getRecurringSummary, () => ({}));
	// Only the transaction table below responds to the date filter.
	const table = useQuery(api.plaid.getRecurringTransactions, () => tableArgs, {
		keepPreviousData: true
	});
	const unmarkRecurringMutation = useMutation(api.plaid.unmarkRecurring);
	const unmarkAmazonItemMutation = useMutation(api.gmail.unmarkAmazonItem);

	const currency = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD'
	});
	const summaryData = $derived(summary.data);
	const byCategory = $derived(summaryData?.byCategory ?? []);
	const byMerchant = $derived((summaryData?.byMerchant ?? []) as MerchantRow[]);
	const transactions = $derived((table.data ?? []) as RecurringRow[]);

	function lastDayOfMonth(month: string) {
		const [year, monthIndex] = month.split('-').map(Number);
		const day = new Date(year, monthIndex, 0).getDate();
		return `${year}-${String(monthIndex).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}

	function formatAmount(amount: number) {
		return currency.format(amount);
	}

	function categoryFor(transaction: RecurringRow) {
		return (
			transaction.userCategory ??
			transaction.categoryDetailed ??
			transaction.categoryPrimary ??
			'Uncategorized'
		);
	}

	async function unmark(merchant: MerchantRow) {
		unmarkingKey = merchant.key;
		errorMessage = '';

		try {
			// Amazon rows are keyed on the item ASIN; everything else on the merchant.
			const result = merchant.asin
				? await unmarkAmazonItemMutation({ asin: merchant.asin })
				: await unmarkRecurringMutation({ normalizedMerchant: merchant.normalizedMerchant });
			statusMessage = `${merchant.label} is no longer recurring (${result.updated} transaction${
				result.updated === 1 ? '' : 's'
			} moved back to dynamic).`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to unmark.';
		} finally {
			unmarkingKey = null;
		}
	}
</script>

<svelte:head>
	<title>Recurring · Money Tracker</title>
	<meta name="description" content="Review and manage transactions marked as recurring." />
</svelte:head>

<main class="money-shell">
	<section class="page-heading">
		<div>
			<p class="eyebrow"><a class="back-link" href="/">← Back to review</a></p>
			<h1>Recurring transactions</h1>
			<p class="lede">
				Everything marked as a recurring merchant, summed and grouped across all time. Unmark a
				merchant to send it and its transactions back to dynamic.
			</p>
		</div>
	</section>

	{#if statusMessage}
		<p class="status-note">{statusMessage}</p>
	{/if}
	{#if errorMessage}
		<p class="error-note">{errorMessage}</p>
	{/if}

	<section class="summary-grid">
		<div class="organic-card">
			<span class="metric-label">Recurring monthly</span>
			<strong>{formatAmount(summaryData?.monthlyTotal ?? 0)}</strong>
			<p>Average per month across {byMerchant.length} recurring merchants</p>
		</div>
		<div class="organic-card">
			<span class="metric-label">Recurring rows</span>
			<strong>{summaryData?.count ?? 0}</strong>
			<p>All classes marked as known recurring</p>
		</div>
		<div class="organic-card">
			<span class="metric-label">Merchants</span>
			<strong>{byMerchant.length}</strong>
			<p>Distinct recurring merchants</p>
		</div>
	</section>

	<section class="dashboard-grid">
		<div class="insight-panel organic-surface">
			<div class="section-heading compact">
				<div>
					<p class="eyebrow">All time</p>
					<h2>By category</h2>
				</div>
			</div>

			<div class="bar-list">
				{#each byCategory as row (row.label)}
					<div class="bar-row">
						<div>
							<strong>{row.label}</strong>
							<span>{row.count} rows</span>
						</div>
						<b>{formatAmount(row.total)}</b>
					</div>
				{:else}
					<div class="empty-state">No recurring categories yet.</div>
				{/each}
			</div>
		</div>

		<div class="insight-panel organic-surface">
			<div class="section-heading compact">
				<div>
					<p class="eyebrow">All time</p>
					<h2>By merchant</h2>
				</div>
			</div>

			<div class="merchant-list">
				<div class="merchant-head">
					<span>Merchant</span>
					<span class="amount-column">Total</span>
					<span class="amount-column">Monthly</span>
					<span></span>
				</div>
				{#each byMerchant as row (row.key)}
					<div class="merchant-row">
						<div class="merchant-info">
							<strong>{row.label}</strong>
							<span>{row.count} rows</span>
						</div>
						<b class="amount-column">{formatAmount(row.total)}</b>
						<b class="amount-column">{formatAmount(row.monthly)}</b>
						<button
							type="button"
							class="unmark-button"
							title="Move this and its transactions back to dynamic"
							disabled={unmarkingKey === row.key}
							onclick={() => unmark(row)}
						>
							{unmarkingKey === row.key ? 'Unmarking...' : 'Unmark'}
						</button>
					</div>
				{:else}
					<div class="empty-state">No recurring merchants yet.</div>
				{/each}
			</div>
		</div>
	</section>

	<section class="data-section">
		<div class="section-heading">
			<div>
				<p class="eyebrow">Transactions</p>
				<h2>Marked recurring</h2>
			</div>
			<label class="table-filter">
				<span class="filter-label">Range</span>
				<span class="filter-controls">
					<input type="month" bind:value={selectedMonth} disabled={allTime} />
					<span class="checkbox-line">
						<input type="checkbox" bind:checked={allTime} />
						All time
					</span>
				</span>
			</label>
		</div>

		<div class="table-shell organic-surface">
			{#if table.isLoading}
				<div class="empty-state">Loading recurring transactions...</div>
			{:else if table.error}
				<div class="empty-state">Unable to load recurring transactions.</div>
			{:else if transactions.length}
				<table>
					<colgroup>
						<col class="date-col" />
						<col class="merchant-col" />
						<col class="category-col" />
						<col class="amount-col" />
					</colgroup>
					<thead>
						<tr>
							<th>Date</th>
							<th>Merchant</th>
							<th>Category</th>
							<th class="amount-column">Amount</th>
						</tr>
					</thead>
					<tbody>
						{#each transactions as transaction (transaction.id)}
							<tr>
								<td data-label="Date">{transaction.date}</td>
								<td data-label="Merchant">
									{#if transaction.amazonItems && transaction.amazonItems.length}
										{#each transaction.amazonItems as item, i (i)}
											{@const short = truncateWords(item.title, 6)}
											<strong use:tooltip={short === item.title ? undefined : item.title}
												>{short}</strong
											>
										{/each}
										<span class="source-line"
											>Gmail · {transaction.merchantName ?? transaction.name}</span
										>
									{:else}
										<strong>{transaction.merchantName ?? transaction.name}</strong>
										<span class="source-line">{transaction.source}</span>
									{/if}
									{#if transaction.pending}
										<span class="pending-chip">Pending</span>
									{/if}
								</td>
								<td data-label="Category">{categoryFor(transaction)}</td>
								<td class="amount-column" data-label="Amount">{formatAmount(transaction.amount)}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<div class="empty-state">No transactions marked as recurring in this range.</div>
			{/if}
		</div>
	</section>
</main>

<style>
	.money-shell {
		width: var(--container-page);
		margin-inline: auto;
		padding: clamp(2rem, 6vw, 5rem) 0;
	}

	.page-heading {
		margin-bottom: clamp(1.5rem, 4vw, 2.5rem);
	}

	.eyebrow,
	.metric-label {
		display: block;
		margin-bottom: 0.5rem;
		color: var(--color-primary);
		font-size: 0.78rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.back-link {
		color: var(--color-primary);
		text-decoration: none;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	.lede {
		max-width: 44rem;
		color: var(--color-muted-foreground);
		font-size: clamp(1.08rem, 2vw, 1.28rem);
	}

	.status-note,
	.error-note {
		margin: 0 0 1rem;
		font-size: 0.95rem;
	}

	.status-note {
		color: var(--color-primary);
	}

	.error-note {
		color: var(--color-destructive);
	}

	.summary-grid,
	.dashboard-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		margin: 1rem 0 clamp(2rem, 5vw, 3.5rem);
	}

	.dashboard-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.summary-grid strong {
		display: block;
		font-family: var(--font-heading);
		font-size: 2.5rem;
		line-height: 1;
	}

	.summary-grid p {
		margin: 0.8rem 0 0;
		color: var(--color-muted-foreground);
	}

	.insight-panel {
		padding: 1.5rem;
		border-radius: 2rem 3.5rem 2rem 2.75rem;
	}

	.data-section {
		margin-top: clamp(2.5rem, 6vw, 4.5rem);
	}

	.section-heading {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}

	.section-heading.compact {
		margin-bottom: 0.8rem;
	}

	.section-heading h2 {
		margin-bottom: 0;
		font-size: clamp(1.8rem, 4vw, 3rem);
	}

	.section-heading.compact h2 {
		font-size: clamp(1.45rem, 3vw, 2rem);
	}

	.table-filter {
		display: grid;
		gap: 0.35rem;
	}

	.filter-label {
		color: var(--color-muted-foreground);
		font-size: 0.78rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.filter-controls {
		display: inline-flex;
		gap: 0.75rem;
		align-items: center;
	}

	.filter-controls input[type='month'] {
		min-height: 2.6rem;
		padding: 0.55rem 0.8rem;
		color: var(--color-foreground);
		background: rgb(254 254 250 / 78%);
		border: 1px solid rgb(222 216 207 / 80%);
		border-radius: var(--radius-pill);
	}

	.checkbox-line {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
		color: var(--color-foreground);
		font-size: 0.85rem;
		font-weight: 800;
		white-space: nowrap;
	}

	.checkbox-line input {
		width: 1.1rem;
		height: 1.1rem;
	}

	.pending-chip {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		margin-left: 0.5rem;
		padding: 0.3rem 0.5rem;
		border-radius: var(--radius-pill);
		color: var(--color-secondary);
		background: rgb(193 140 93 / 12%);
		font-size: 0.78rem;
		font-weight: 800;
		line-height: 1;
		white-space: nowrap;
	}

	.bar-list {
		display: grid;
		gap: 0.8rem;
	}

	.bar-row {
		display: grid;
		grid-template-columns: minmax(8rem, 1fr) max-content;
		gap: 0.8rem;
		align-items: center;
	}

	.bar-row b {
		font-weight: 900;
	}

	.merchant-list {
		display: grid;
		gap: 0.8rem;
	}

	.merchant-head,
	.merchant-row {
		display: grid;
		grid-template-columns: minmax(7rem, 1fr) 6rem 6rem 6.5rem;
		gap: 0.8rem;
		align-items: center;
	}

	.merchant-head {
		color: var(--color-muted-foreground);
		font-size: 0.72rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.bar-row > div,
	.merchant-info {
		min-width: 0;
	}

	.bar-row strong,
	.merchant-info strong,
	.source-line {
		display: block;
	}

	.bar-row strong,
	.merchant-info strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bar-row span,
	.merchant-info span,
	.source-line {
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
	}

	.table-shell {
		overflow: hidden;
		border-radius: 1.8rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}

	.date-col {
		width: 7rem;
	}

	.merchant-col {
		width: 34%;
	}

	.category-col {
		width: 42%;
	}

	.amount-col {
		width: 7rem;
	}

	th,
	td {
		padding: 0.95rem 0.8rem;
		border-bottom: 1px solid rgb(222 216 207 / 58%);
		text-align: left;
		vertical-align: middle;
		overflow-wrap: anywhere;
		word-break: normal;
	}

	th:first-child,
	td:first-child,
	.amount-column {
		white-space: nowrap;
		overflow-wrap: normal;
	}

	th {
		color: var(--color-muted-foreground);
		font-size: 0.78rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	td strong {
		display: block;
		font-weight: 900;
		overflow-wrap: anywhere;
	}

	tr:last-child td {
		border-bottom: 0;
	}

	.amount-column {
		text-align: right;
		font-weight: 900;
	}

	.unmark-button {
		width: 100%;
		min-height: 2.1rem;
		padding: 0.45rem 0.7rem;
		color: var(--color-destructive);
		background: rgb(168 84 72 / 10%);
		border: 1px solid rgb(168 84 72 / 30%);
		border-radius: var(--radius-pill);
		font-size: 0.72rem;
		font-weight: 900;
		line-height: 1.05;
		cursor: pointer;
		transition:
			transform 220ms ease,
			background-color 220ms ease;
	}

	.unmark-button:hover {
		transform: translateY(-0.08rem);
		background: rgb(168 84 72 / 18%);
	}

	.unmark-button:disabled {
		cursor: not-allowed;
		opacity: 0.58;
		transform: none;
	}

	.empty-state {
		padding: 2rem;
		color: var(--color-muted-foreground);
	}

	@media (max-width: 960px) {
		.summary-grid,
		.dashboard-grid {
			grid-template-columns: 1fr;
		}

		.section-heading {
			align-items: start;
			flex-direction: column;
		}

		.bar-row,
		.merchant-row {
			grid-template-columns: 1fr;
		}

		.merchant-head {
			display: none;
		}
	}

	@media (max-width: 760px) {
		.table-shell {
			background: transparent;
			border: 0;
			box-shadow: none;
		}

		table,
		thead,
		tbody,
		tr,
		th,
		td {
			display: block;
			width: 100%;
		}

		colgroup,
		thead {
			display: none;
		}

		tr {
			margin-bottom: 0.9rem;
			padding: 1rem;
			background: rgb(254 254 250 / 90%);
			border: 1px solid rgb(222 216 207 / 65%);
			border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
			box-shadow: var(--shadow-soft);
		}

		td {
			display: grid;
			grid-template-columns: 6.5rem minmax(0, 1fr);
			gap: 0.75rem;
			padding: 0.45rem 0;
			border-bottom: 0;
		}

		td::before {
			color: var(--color-muted-foreground);
			font-size: 0.72rem;
			font-weight: 900;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			content: attr(data-label);
		}
	}
</style>
