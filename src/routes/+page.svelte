<script lang="ts">
	import { useAction, useMutation, useQuery } from 'convex-svelte';
	import { api } from '../convex/_generated/api.js';
	import type { Id } from '../convex/_generated/dataModel.js';

	type Classification = 'known_recurring' | 'expected' | 'dynamic' | 'unreviewed';
	type MerchantClassification = 'known_recurring' | 'expected';
	type ClassificationFilter = Classification | 'all';
	type TransactionRow = {
		id: Id<'transactions'>;
		date: string;
		name: string;
		merchantName: string | null;
		amount: number;
		kind: 'expense' | 'income' | 'transfer';
		pending: boolean;
		categoryPrimary: string | null;
		categoryDetailed: string | null;
		userCategory?: string | null;
		classification: Classification;
		classificationSource: string;
		source: string;
		removed?: boolean;
	};

	const today = new Date();
	const initialMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

	let selectedMonth = $state(initialMonth);
	let classificationFilter = $state<ClassificationFilter>('dynamic');
	let searchTerm = $state('');
	let isConnecting = $state(false);
	let isSyncing = $state(false);
	let markingTransactionId = $state<string | null>(null);
	let statusMessage = $state('');
	let errorMessage = $state('');

	const monthStart = $derived(`${selectedMonth}-01`);
	const monthEnd = $derived(lastDayOfMonth(selectedMonth));
	const transactionArgs = $derived({ limit: 100 });

	const plaidStatus = useQuery(api.plaid.getConnectionStatus, () => ({}));
	const transactions = useQuery(api.plaid.listRecentTransactions, () => transactionArgs, {
		keepPreviousData: true
	});
	const createLinkToken = useAction(api.plaidActions.createLinkToken);
	const exchangePublicToken = useAction(api.plaidActions.exchangePublicToken);
	const syncAllItems = useAction(api.plaidActions.syncAllItems);
	const markTransactionMutation = useMutation(api.plaid.markTransaction);
	const markCategoryExpectedMutation = useMutation(api.plaid.markCategoryExpected);
	const markCategoryTransferMutation = useMutation(api.plaid.markCategoryTransfer);

	const currency = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD'
	});
	const percent = new Intl.NumberFormat('en-US', {
		style: 'percent',
		maximumFractionDigits: 0
	});

	const allTransactions = $derived((transactions.data ?? []) as TransactionRow[]);
	const visibleTransactions = $derived.by(() => {
		const term = searchTerm.trim().toLowerCase();

		return allTransactions.filter((transaction) => {
			const classification = effectiveClassification(transaction);

			if (transaction.removed) return false;
			if (transaction.kind !== 'expense') return false;
			if (transaction.date < monthStart || transaction.date > monthEnd) return false;
			if (classificationFilter !== 'all' && classification !== classificationFilter) {
				return false;
			}
			if (!term) return true;

			return [
				transaction.name,
				transaction.merchantName,
				transaction.categoryPrimary,
				transaction.categoryDetailed,
				transaction.userCategory
			]
				.filter(Boolean)
				.some((value) => value!.toLowerCase().includes(term));
		});
	});
	const dynamicRows = $derived(
		allTransactions.filter(
			(transaction) =>
				!transaction.removed &&
				transaction.kind === 'expense' &&
				effectiveClassification(transaction) === 'dynamic' &&
				transaction.date >= monthStart &&
				transaction.date <= monthEnd
		)
	);
	const dynamicTotal = $derived(
		dynamicRows.reduce((sum, transaction) => sum + transaction.amount, 0)
	);
	const dynamicByCategory = $derived(
		summarizeBy(
			dynamicRows,
			(transaction) =>
				transaction.userCategory ??
				transaction.categoryDetailed ??
				transaction.categoryPrimary ??
				'Uncategorized'
		)
	);
	const dynamicByMerchant = $derived(
		summarizeBy(dynamicRows, (transaction) => transaction.merchantName ?? transaction.name)
	);
	const recurringCount = $derived(
		allTransactions.filter(
			(transaction) =>
				!transaction.removed &&
				effectiveClassification(transaction) === 'known_recurring' &&
				transaction.date >= monthStart &&
				transaction.date <= monthEnd
		).length
	);
	const maxCategoryTotal = $derived(Math.max(...dynamicByCategory.map((row) => row.total), 1));
	const maxMerchantTotal = $derived(Math.max(...dynamicByMerchant.map((row) => row.total), 1));

	function lastDayOfMonth(month: string) {
		const [year, monthIndex] = month.split('-').map(Number);
		const day = new Date(year, monthIndex, 0).getDate();
		return `${year}-${String(monthIndex).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}

	function formatAmount(amount: number) {
		return currency.format(amount);
	}

	function formatDate(timestamp: number | null) {
		if (!timestamp) return 'Never';
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(timestamp));
	}

	function classificationLabel(value: Classification) {
		return value.replace('_', ' ');
	}

	function effectiveClassification(
		transaction: TransactionRow
	): Exclude<Classification, 'unreviewed'> {
		return transaction.classification === 'unreviewed' ? 'dynamic' : transaction.classification;
	}

	function categoryFor(transaction: {
		userCategory?: string | null;
		categoryDetailed: string | null;
		categoryPrimary: string | null;
	}) {
		return (
			transaction.userCategory ?? transaction.categoryDetailed ?? transaction.categoryPrimary ?? ''
		);
	}

	function providerCategoryFor(transaction: {
		categoryDetailed: string | null;
		categoryPrimary: string | null;
	}) {
		return transaction.categoryDetailed ?? transaction.categoryPrimary ?? '';
	}

	function loadPlaidScript() {
		if (window.Plaid) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const existing = document.querySelector<HTMLScriptElement>(
				'script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]'
			);
			if (existing) {
				existing.addEventListener('load', () => resolve(), { once: true });
				existing.addEventListener('error', () => reject(new Error('Plaid Link failed to load')), {
					once: true
				});
				return;
			}

			const script = document.createElement('script');
			script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('Plaid Link failed to load'));
			document.head.appendChild(script);
		});
	}

	async function connectPlaid() {
		isConnecting = true;
		statusMessage = 'Preparing Plaid Link...';
		errorMessage = '';

		try {
			await loadPlaidScript();
			const token = await createLinkToken({});

			if (!token.hasRedirectUri) {
				statusMessage =
					'Plaid Link is opening. Chase may require a configured redirect URI for OAuth.';
			}

			const handler = window.Plaid?.create({
				token: token.linkToken,
				onSuccess: async (publicToken, metadata) => {
					statusMessage = 'Saving Plaid connection...';
					await exchangePublicToken({
						publicToken,
						institutionId: metadata.institution?.institution_id,
						institutionName: metadata.institution?.name
					});
					statusMessage = 'Plaid connected. Syncing transactions...';
					await runSync();
				},
				onExit: (error) => {
					if (error) {
						errorMessage =
							'Plaid Link exited with an error. Check the Plaid dashboard for details.';
					}
				}
			});

			handler?.open();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to connect Plaid.';
		} finally {
			isConnecting = false;
		}
	}

	async function runSync() {
		isSyncing = true;
		errorMessage = '';

		try {
			const results = await syncAllItems({});
			const added = results.reduce((sum, item) => sum + item.added, 0);
			const modified = results.reduce((sum, item) => sum + item.modified, 0);
			const removed = results.reduce((sum, item) => sum + item.removed, 0);
			statusMessage = `Sync complete: ${added} added, ${modified} modified, ${removed} removed.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to sync Plaid transactions.';
		} finally {
			isSyncing = false;
		}
	}

	async function markTransaction(
		transaction: {
			id: Id<'transactions'>;
			merchantName: string | null;
			name: string;
			userCategory?: string | null;
			categoryDetailed: string | null;
			categoryPrimary: string | null;
		},
		classification: MerchantClassification
	) {
		markingTransactionId = transaction.id;
		errorMessage = '';

		try {
			const category = categoryFor(transaction);
			await markTransactionMutation({
				transactionId: transaction.id,
				classification,
				createMerchantRule: true,
				ruleMatchType: 'exact',
				...(category ? { category } : {})
			});
			statusMessage = `${transaction.merchantName ?? transaction.name} will now be treated as ${classificationLabel(classification)}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to mark transaction.';
		} finally {
			markingTransactionId = null;
		}
	}

	async function markExpectedCategory(transaction: {
		id: Id<'transactions'>;
		categoryDetailed: string | null;
		categoryPrimary: string | null;
	}) {
		markingTransactionId = transaction.id;
		errorMessage = '';

		try {
			const category = providerCategoryFor(transaction);
			if (!category) {
				throw new Error('This transaction does not have a category to use as a rule.');
			}

			await markCategoryExpectedMutation({
				transactionId: transaction.id
			});
			statusMessage = `${category} will now be treated as expected.`;
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : 'Unable to mark category as expected.';
		} finally {
			markingTransactionId = null;
		}
	}

	async function markTransferCategory(transaction: {
		id: Id<'transactions'>;
		categoryDetailed: string | null;
		categoryPrimary: string | null;
	}) {
		markingTransactionId = transaction.id;
		errorMessage = '';

		try {
			const category = providerCategoryFor(transaction);
			if (!category) {
				throw new Error('This transaction does not have a category to ignore.');
			}

			await markCategoryTransferMutation({
				transactionId: transaction.id
			});
			statusMessage = `${category} will now be ignored as a transfer.`;
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : 'Unable to ignore category as transfer.';
		} finally {
			markingTransactionId = null;
		}
	}

	function summarizeBy(rows: TransactionRow[], keyFor: (row: TransactionRow) => string) {
		const totals: Record<string, { label: string; total: number; count: number }> = {};

		for (const row of rows) {
			const label = keyFor(row);
			const existing = totals[label] ?? { label, total: 0, count: 0 };
			existing.total += row.amount;
			existing.count += 1;
			totals[label] = existing;
		}

		return Object.values(totals)
			.sort((a, b) => b.total - a.total)
			.slice(0, 8);
	}
</script>

<svelte:head>
	<title>Money Tracker</title>
	<meta
		name="description"
		content="Personal transaction tracker for separating expected spending from dynamic expenses."
	/>
</svelte:head>

<main class="money-shell">
	<section class="hero">
		<div>
			<p class="eyebrow">Personal Money Tracker</p>
			<h1>Review the money that moved outside the plan.</h1>
			<p class="lede">
				Dynamic is the default. Mark a merchant as recurring or expected once, and future matching
				transactions can inherit that merchant-level rule.
			</p>
		</div>

		<div class="connection-panel organic-surface">
			<div>
				<span class="panel-label">Plaid</span>
				{#if plaidStatus.isLoading}
					<strong>Checking connection...</strong>
				{:else if plaidStatus.data?.connected}
					<strong>Connected</strong>
				{:else}
					<strong>Not connected</strong>
				{/if}
			</div>

			<div class="button-row">
				<button
					class="button button-primary"
					type="button"
					onclick={connectPlaid}
					disabled={isConnecting}
				>
					{isConnecting ? 'Connecting...' : 'Connect Plaid'}
				</button>
				<button
					class="button button-outline"
					type="button"
					onclick={runSync}
					disabled={isSyncing || !plaidStatus.data?.connected}
				>
					{isSyncing ? 'Syncing...' : 'Sync now'}
				</button>
			</div>

			{#if statusMessage}
				<p class="status-note">{statusMessage}</p>
			{/if}
			{#if errorMessage}
				<p class="error-note">{errorMessage}</p>
			{/if}
		</div>
	</section>

	<section class="control-bar organic-surface" aria-label="Transaction filters">
		<label>
			<span>Month</span>
			<input type="month" bind:value={selectedMonth} />
		</label>
		<label>
			<span>Class</span>
			<select bind:value={classificationFilter}>
				<option value="all">All</option>
				<option value="dynamic">Dynamic</option>
				<option value="expected">Expected</option>
				<option value="known_recurring">Known recurring</option>
			</select>
		</label>
		<label class="search-field">
			<span>Search</span>
			<input type="search" bind:value={searchTerm} placeholder="Merchant, category, notes" />
		</label>
	</section>

	<section class="summary-grid">
		<div class="organic-card">
			<span class="metric-label">Dynamic spend</span>
			<strong>{formatAmount(dynamicTotal)}</strong>
			<p>{dynamicRows.length} transactions in {selectedMonth}</p>
		</div>
		<div class="organic-card">
			<span class="metric-label">Recurring</span>
			<strong>{recurringCount}</strong>
			<p>Merchant-rule rows in the selected period</p>
		</div>
		<div class="organic-card">
			<span class="metric-label">Loaded rows</span>
			<strong>{allTransactions.length}</strong>
			<p>Recent rows available for local filters</p>
		</div>
	</section>

	<section class="dashboard-grid">
		<div class="insight-panel organic-surface">
			<div class="section-heading compact">
				<div>
					<p class="eyebrow">Dynamic</p>
					<h2>By category</h2>
				</div>
			</div>

			<div class="bar-list">
				{#each dynamicByCategory as row (row.label)}
					<div class="bar-row">
						<div>
							<strong>{row.label}</strong>
							<span>{row.count} rows</span>
						</div>
						<div class="bar-track" aria-hidden="true">
							<span style={`width: ${percent.format(row.total / maxCategoryTotal)}`}></span>
						</div>
						<b>{formatAmount(row.total)}</b>
					</div>
				{:else}
					<div class="empty-state">No dynamic categories for this month.</div>
				{/each}
			</div>
		</div>

		<div class="insight-panel organic-surface">
			<div class="section-heading compact">
				<div>
					<p class="eyebrow">Dynamic</p>
					<h2>Top merchants</h2>
				</div>
			</div>

			<div class="bar-list">
				{#each dynamicByMerchant as row (row.label)}
					<div class="bar-row">
						<div>
							<strong>{row.label}</strong>
							<span>{row.count} rows</span>
						</div>
						<div class="bar-track" aria-hidden="true">
							<span style={`width: ${percent.format(row.total / maxMerchantTotal)}`}></span>
						</div>
						<b>{formatAmount(row.total)}</b>
					</div>
				{:else}
					<div class="empty-state">No dynamic merchants for this month.</div>
				{/each}
			</div>
		</div>
	</section>

	<section class="data-section">
		<div class="section-heading">
			<div>
				<p class="eyebrow">Transactions</p>
				<h2>Review queue</h2>
			</div>
			{#if plaidStatus.data?.items[0]}
				<span class="sync-chip">Last sync {formatDate(plaidStatus.data.items[0].lastSyncAt)}</span>
			{/if}
		</div>

		<div class="table-shell organic-surface">
			{#if transactions.isLoading}
				<div class="empty-state">Loading transactions...</div>
			{:else if transactions.error}
				<div class="empty-state">Unable to load transactions.</div>
			{:else if visibleTransactions.length}
				<table>
					<colgroup>
						<col class="date-col" />
						<col class="merchant-col" />
						<col class="category-col" />
						<col class="class-col" />
						<col class="amount-col" />
						<col class="actions-col" />
					</colgroup>
					<thead>
						<tr>
							<th>Date</th>
							<th>Merchant</th>
							<th>Category</th>
							<th>Class</th>
							<th class="amount-column">Amount</th>
							<th>Set merchant rule</th>
						</tr>
					</thead>
					<tbody>
						{#each visibleTransactions as transaction (transaction.id)}
							<tr>
								<td data-label="Date">{transaction.date}</td>
								<td data-label="Merchant">
									<strong>{transaction.merchantName ?? transaction.name}</strong>
									<span class="source-line">{transaction.source}</span>
									{#if transaction.pending}
										<span class="pending-chip">Pending</span>
									{/if}
								</td>
								<td data-label="Category">
									<div class="category-stack">
										<span>{categoryFor(transaction) || 'Uncategorized'}</span>
										{#if providerCategoryFor(transaction)}
											<button
												type="button"
												class="text-action"
												title="Treat this provider category as expected"
												disabled={markingTransactionId === transaction.id}
												onclick={() => markExpectedCategory(transaction)}
											>
												Expected category
											</button>
											<button
												type="button"
												class="text-action transfer-action"
												title="Ignore this provider category as a transfer"
												disabled={markingTransactionId === transaction.id}
												onclick={() => markTransferCategory(transaction)}
											>
												Ignore transfer
											</button>
										{/if}
									</div>
								</td>
								<td data-label="Class">
									<span class={`class-chip ${effectiveClassification(transaction)}`}>
										{classificationLabel(effectiveClassification(transaction))}
									</span>
									<span class="source-line">{transaction.classificationSource}</span>
								</td>
								<td class="amount-column" data-label="Amount">{formatAmount(transaction.amount)}</td
								>
								<td data-label="Set merchant rule">
									<div class="mark-actions">
										<button
											type="button"
											title="Treat this merchant as recurring"
											disabled={markingTransactionId === transaction.id}
											onclick={() => markTransaction(transaction, 'known_recurring')}
										>
											Recurring merchant
										</button>
										<button
											type="button"
											title="Treat this merchant as expected"
											disabled={markingTransactionId === transaction.id}
											onclick={() => markTransaction(transaction, 'expected')}
										>
											Expected merchant
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<div class="empty-state">No matching transactions in this period.</div>
			{/if}
		</div>
	</section>

	<section class="data-section">
		<div class="section-heading">
			<div>
				<p class="eyebrow">Accounts</p>
				<h2>Connected accounts</h2>
			</div>
		</div>

		<div class="account-grid">
			{#each plaidStatus.data?.accounts ?? [] as account (account.id)}
				<article class="account-card">
					<strong>{account.name}</strong>
					<span
						>{account.subtype ?? account.type ?? 'Account'}
						{account.mask ? `...${account.mask}` : ''}</span
					>
				</article>
			{:else}
				<div class="empty-state organic-surface">No accounts connected yet.</div>
			{/each}
		</div>
	</section>
</main>

<style>
	.money-shell {
		width: var(--container-page);
		margin-inline: auto;
		padding: clamp(2rem, 6vw, 5rem) 0;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1.35fr) minmax(20rem, 0.8fr);
		gap: clamp(2rem, 5vw, 4rem);
		align-items: center;
		min-height: 34rem;
	}

	.eyebrow,
	.panel-label,
	.metric-label {
		display: block;
		margin-bottom: 0.5rem;
		color: var(--color-primary);
		font-size: 0.78rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.lede {
		max-width: 44rem;
		color: var(--color-muted-foreground);
		font-size: clamp(1.08rem, 2vw, 1.28rem);
	}

	.connection-panel,
	.insight-panel {
		padding: 1.5rem;
		border-radius: 2rem 3.5rem 2rem 2.75rem;
	}

	.connection-panel strong {
		display: block;
		font-family: var(--font-heading);
		font-size: 1.8rem;
		line-height: 1.1;
	}

	.button-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	.button:disabled,
	.mark-actions button:disabled {
		cursor: not-allowed;
		opacity: 0.58;
		transform: none;
	}

	.button-outline {
		color: var(--color-secondary);
		background: rgb(254 254 250 / 70%);
		border: 1px solid rgb(193 140 93 / 45%);
	}

	.status-note,
	.error-note {
		margin: 1rem 0 0;
		font-size: 0.95rem;
	}

	.status-note {
		color: var(--color-primary);
	}

	.error-note {
		color: var(--color-destructive);
	}

	.control-bar {
		display: grid;
		grid-template-columns: minmax(10rem, 0.7fr) minmax(12rem, 0.8fr) minmax(16rem, 1.5fr);
		gap: 1rem;
		margin-bottom: 1rem;
		padding: 1rem;
		border-radius: 1.5rem 2.5rem 1.5rem 2rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
		color: var(--color-muted-foreground);
		font-size: 0.85rem;
		font-weight: 800;
	}

	input,
	select {
		width: 100%;
		min-height: 2.8rem;
		padding: 0.65rem 0.85rem;
		color: var(--color-foreground);
		background: rgb(254 254 250 / 78%);
		border: 1px solid rgb(222 216 207 / 80%);
		border-radius: var(--radius-pill);
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

	.sync-chip,
	.pending-chip,
	.class-chip {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		border-radius: var(--radius-pill);
		font-size: 0.78rem;
		font-weight: 800;
		line-height: 1;
		white-space: nowrap;
	}

	.sync-chip {
		padding: 0.55rem 0.8rem;
		color: var(--color-accent-foreground);
		background: var(--color-accent);
	}

	.pending-chip {
		margin-left: 0.5rem;
		padding: 0.3rem 0.5rem;
		color: var(--color-secondary);
		background: rgb(193 140 93 / 12%);
	}

	.class-chip {
		padding: 0.45rem 0.62rem;
		color: var(--color-muted-foreground);
		background: var(--color-muted);
		text-transform: capitalize;
	}

	.class-chip.dynamic {
		color: var(--color-destructive);
		background: rgb(168 84 72 / 12%);
	}

	.class-chip.expected {
		color: var(--color-primary);
		background: rgb(93 112 82 / 13%);
	}

	.class-chip.known_recurring {
		color: var(--color-secondary);
		background: rgb(193 140 93 / 14%);
	}

	.bar-list {
		display: grid;
		gap: 0.8rem;
	}

	.bar-row {
		display: grid;
		grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 1.2fr) max-content;
		gap: 0.8rem;
		align-items: center;
	}

	.bar-row strong,
	.source-line {
		display: block;
	}

	.bar-row span,
	.source-line {
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
	}

	.bar-track {
		height: 0.7rem;
		overflow: hidden;
		background: rgb(240 235 229 / 95%);
		border-radius: var(--radius-pill);
	}

	.bar-track span {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
		border-radius: inherit;
	}

	.account-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1rem;
	}

	.account-card {
		padding: 1.1rem 1.25rem;
		background: rgb(254 254 250 / 82%);
		border: 1px solid rgb(222 216 207 / 70%);
		border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
		box-shadow: var(--shadow-soft);
	}

	.account-card strong,
	.account-card span {
		display: block;
	}

	.account-card span {
		color: var(--color-muted-foreground);
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
		width: 6%;
	}

	.merchant-col {
		width: 15%;
	}

	.category-col {
		width: 30%;
	}

	.class-col {
		width: 11%;
	}

	.amount-col {
		width: 8%;
	}

	.actions-col {
		width: 30%;
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

	.category-stack {
		display: grid;
		gap: 0.35rem;
		align-items: start;
	}

	.text-action {
		width: fit-content;
		min-width: 0;
		padding: 0;
		color: var(--color-primary);
		background: transparent;
		border: 0;
		border-radius: 0;
		font-size: 0.76rem;
		font-weight: 900;
		line-height: 1.2;
		text-align: left;
		text-decoration: underline;
		text-decoration-color: rgb(91 115 77 / 35%);
		text-underline-offset: 0.18em;
		cursor: pointer;
	}

	.text-action:hover {
		color: var(--color-accent-foreground);
		text-decoration-color: currentColor;
	}

	.transfer-action {
		color: var(--color-muted-foreground);
		text-decoration-color: rgb(82 76 68 / 30%);
	}

	.text-action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.mark-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.35rem;
	}

	.mark-actions button {
		min-height: 2.1rem;
		min-width: 0;
		padding: 0.45rem 0.4rem;
		color: var(--color-accent-foreground);
		background: rgb(230 220 205 / 50%);
		border: 1px solid rgb(222 216 207 / 80%);
		border-radius: var(--radius-pill);
		font-size: 0.68rem;
		font-weight: 900;
		line-height: 1.05;
		cursor: pointer;
		transition:
			transform 220ms ease,
			background-color 220ms ease;
	}

	.mark-actions button:hover {
		transform: translateY(-0.08rem);
		background: rgb(230 220 205 / 78%);
	}

	.empty-state {
		padding: 2rem;
		color: var(--color-muted-foreground);
	}

	@media (max-width: 960px) {
		.hero,
		.summary-grid,
		.dashboard-grid,
		.control-bar {
			grid-template-columns: 1fr;
		}

		.hero {
			min-height: auto;
		}

		.section-heading {
			align-items: start;
			flex-direction: column;
		}

		.bar-row {
			grid-template-columns: 1fr;
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

		.mark-actions {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
