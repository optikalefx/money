<script lang="ts">
	import { useAction, useMutation, useQuery } from 'convex-svelte';
	import { api } from '../convex/_generated/api.js';
	import type { Id } from '../convex/_generated/dataModel.js';
	import { tooltip, truncateWords } from '$lib/tooltip';

	type Classification = 'known_recurring' | 'expected' | 'dynamic' | 'unreviewed';
	type MerchantClassification = 'known_recurring' | 'expected';
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
		categorySlug?: string | null;
		classification: Classification;
		classificationSource: string;
		source: string;
		removed?: boolean;
		amazonItems?: Array<{
			title: string;
			quantity: number | null;
			amount: number | null;
			category?: string | null;
		}>;
	};

	const today = new Date();
	const initialMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

	let selectedMonth = $state(initialMonth);
	let searchTerm = $state('');
	let amountSort = $state<'asc' | 'desc' | null>(null);
	let isConnecting = $state(false);
	let isSyncing = $state(false);
	let isConnectingGmail = $state(false);
	let isSyncingGmail = $state(false);
	let markingTransactionId = $state<string | null>(null);
	let statusMessage = $state('');
	let errorMessage = $state('');

	const monthStart = $derived(`${selectedMonth}-01`);
	const monthEnd = $derived(lastDayOfMonth(selectedMonth));
	// Scope the recent-rows query to the selected month so the 100-row cap applies *within* the
	// month, not globally. Otherwise picking an older month shows an empty queue because the 100
	// most-recent rows are all from later months. Classification isn't narrowed server-side: the
	// queue intentionally shows both `dynamic` and `unreviewed` rows (see effectiveClassification),
	// and the index filter only matches a single classification value.
	const transactionArgs = $derived({ limit: 100, startDate: monthStart, endDate: monthEnd });

	// A rolling 12-month window that always includes the selected month, for the
	// month-over-month breakdown (server-side, so it isn't limited to the recent-rows cap).
	const windowStart = $derived(shiftMonth(minMonth(initialMonth, selectedMonth), -11));
	const windowEnd = $derived(maxMonth(initialMonth, selectedMonth));

	const plaidStatus = useQuery(api.plaid.getConnectionStatus, () => ({}));
	const transactions = useQuery(api.plaid.listRecentTransactions, () => transactionArgs, {
		keepPreviousData: true
	});
	const monthlyBreakdown = useQuery(
		api.plaid.getMonthlyDynamicBreakdown,
		() => ({ startMonth: windowStart, endMonth: windowEnd }),
		{ keepPreviousData: true }
	);
	const categoriesQuery = useQuery(api.categories.listCategories, () => ({}));
	const gmailStatus = useQuery(api.gmail.getConnectionStatus, () => ({}));
	const createLinkToken = useAction(api.plaidActions.createLinkToken);
	const exchangePublicToken = useAction(api.plaidActions.exchangePublicToken);
	const syncAllItems = useAction(api.plaidActions.syncAllItems);
	const getGmailAuthUrl = useAction(api.gmailActions.getGmailAuthUrl);
	const syncGmailAction = useAction(api.gmailActions.syncGmail);
	const markTransactionMutation = useMutation(api.plaid.markTransaction);
	const markAmazonItemMutation = useMutation(api.gmail.markAmazonItem);
	const markCategoryExpectedMutation = useMutation(api.plaid.markCategoryExpected);
	const markCategoryTransferMutation = useMutation(api.plaid.markCategoryTransfer);

	const currency = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD'
	});

	const categoryNames = $derived(
		new Map((categoriesQuery.data ?? []).map((category) => [category.slug, category.name]))
	);
	const allTransactions = $derived((transactions.data ?? []) as TransactionRow[]);
	const visibleTransactions = $derived.by(() => {
		const term = searchTerm.trim().toLowerCase();

		return allTransactions.filter((transaction) => {
			const classification = effectiveClassification(transaction);

			if (transaction.removed) return false;
			if (transaction.kind !== 'expense') return false;
			if (transaction.date < monthStart || transaction.date > monthEnd) return false;
			if (classification !== 'dynamic') return false;
			if (!term) return true;

			return [
				transaction.name,
				transaction.merchantName,
				transaction.categoryPrimary,
				transaction.categoryDetailed,
				transaction.userCategory,
				displayCategory(transaction),
				...(transaction.amazonItems?.map((item) => item.title) ?? [])
			]
				.filter(Boolean)
				.some((value) => value!.toLowerCase().includes(term));
		});
	});
	// Optional amount sort layered on top of the filtered queue. Null keeps the default (date) order.
	const sortedTransactions = $derived.by(() => {
		if (!amountSort) return visibleTransactions;
		const dir = amountSort === 'asc' ? 1 : -1;
		return [...visibleTransactions].sort((a, b) => (a.amount - b.amount) * dir);
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
	// Month-over-month view (server-computed, canonical categories incl. exploded Amazon items).
	const monthlyMonths = $derived(monthlyBreakdown.data?.months ?? []);
	const selectedMonthBreakdown = $derived(
		monthlyMonths.find((entry) => entry.month === selectedMonth)
	);
	const dynamicTotalMonthly = $derived(selectedMonthBreakdown?.total ?? 0);
	const canonicalCategoryRows = $derived(selectedMonthBreakdown?.byCategory ?? []);
	const maxMonthTotal = $derived(
		monthlyMonths.reduce((max, entry) => Math.max(max, entry.total), 0)
	);

	function lastDayOfMonth(month: string) {
		const [year, monthIndex] = month.split('-').map(Number);
		const day = new Date(year, monthIndex, 0).getDate();
		return `${year}-${String(monthIndex).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}

	function shiftMonth(month: string, delta: number) {
		const [year, monthNum] = month.split('-').map(Number);
		const index = year * 12 + (monthNum - 1) + delta;
		return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
	}

	function minMonth(a: string, b: string) {
		return a < b ? a : b;
	}

	function maxMonth(a: string, b: string) {
		return a > b ? a : b;
	}

	function formatMonthShort(month: string) {
		const [year, monthNum] = month.split('-').map(Number);
		return new Intl.DateTimeFormat('en-US', { month: 'short' }).format(
			new Date(year, monthNum - 1, 1)
		);
	}

	function formatMonthLong(month: string) {
		const [year, monthNum] = month.split('-').map(Number);
		return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
			new Date(year, monthNum - 1, 1)
		);
	}

	function formatAmount(amount: number) {
		return currency.format(amount);
	}

	function filterBySearch(label: string) {
		searchTerm = searchTerm === label ? '' : label;
	}

	// Cycle the Amount column sort: none → ascending → descending → none.
	function cycleAmountSort() {
		amountSort = amountSort === null ? 'asc' : amountSort === 'asc' ? 'desc' : null;
	}

	// Filters that narrow the review queue, surfaced as dismissible chips by the title. The month
	// chip only appears once the user has moved off the default (current) month.
	const activeFilters = $derived.by(() => {
		const filters: { key: string; label: string; clear: () => void }[] = [];
		if (selectedMonth !== initialMonth) {
			filters.push({
				key: 'month',
				label: formatMonthLong(selectedMonth),
				clear: () => (selectedMonth = initialMonth)
			});
		}
		const term = searchTerm.trim();
		if (term) {
			filters.push({ key: 'search', label: term, clear: () => (searchTerm = '') });
		}
		return filters;
	});

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

	function slugName(slug: string) {
		return (
			categoryNames.get(slug) ??
			slug
				.split('-')
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(' ')
		);
	}

	// The normalized (canonical) category to show in the review queue. Amazon rows carry
	// per-item categories; everything else uses the transaction's resolved slug. Falls back to
	// the raw provider category when a row hasn't been categorized yet.
	function displayCategory(transaction: TransactionRow) {
		if (transaction.amazonItems && transaction.amazonItems.length) {
			const names = [
				...new Set(
					transaction.amazonItems
						.map((item) => item.category)
						.filter((slug): slug is string => !!slug)
						.map(slugName)
				)
			];
			if (names.length) return names.join(', ');
		}
		if (transaction.categorySlug) return slugName(transaction.categorySlug);
		return categoryFor(transaction) || 'Uncategorized';
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

	async function connectGmail() {
		isConnectingGmail = true;
		errorMessage = '';
		statusMessage = 'Opening Google sign-in...';

		try {
			const { url } = await getGmailAuthUrl({ returnTo: window.location.origin });
			window.location.href = url;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to start Gmail connection.';
			isConnectingGmail = false;
		}
	}

	async function syncGmail() {
		isSyncingGmail = true;
		errorMessage = '';

		try {
			const result = await syncGmailAction({});
			statusMessage = `Gmail sync complete: ${result.imported} orders imported from ${result.scanned} messages.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to sync Gmail.';
		} finally {
			isSyncingGmail = false;
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
			amazonItems?: Array<{ title: string }>;
		},
		classification: MerchantClassification
	) {
		markingTransactionId = transaction.id;
		errorMessage = '';

		try {
			const category = categoryFor(transaction);

			// Amazon rows are keyed on the item's ASIN, so repeat purchases auto-classify
			// without reclassifying every unrelated Amazon transaction.
			if (transaction.amazonItems && transaction.amazonItems.length) {
				const result = await markAmazonItemMutation({
					transactionId: transaction.id,
					classification,
					...(category ? { category } : {})
				});
				const label = transaction.amazonItems[0].title;
				statusMessage = `${label} will now be treated as ${classificationLabel(classification)} (${result.updated} matching transaction${result.updated === 1 ? '' : 's'}).`;
				return;
			}

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
			<p class="hero-nav">
				<a class="nav-link" href="/recurring">View recurring transactions →</a>
				<a class="nav-link" href="/categories">Manage categories →</a>
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
					{isConnecting ? 'Connecting...' : 'Connect Account'}
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

			<div class="panel-divider"></div>

			<div>
				<span class="panel-label">Gmail · Amazon</span>
				{#if gmailStatus.isLoading}
					<strong>Checking connection...</strong>
				{:else if gmailStatus.data?.connected}
					<strong>Connected</strong>
					{#if gmailStatus.data.email}
						<span class="panel-sub">{gmailStatus.data.email}</span>
					{/if}
				{:else if gmailStatus.data?.status === 'needs_reconnect'}
					<strong>Reconnect needed</strong>
				{:else}
					<strong>Not connected</strong>
				{/if}
			</div>

			<div class="button-row">
				<button
					class="button button-primary"
					type="button"
					onclick={connectGmail}
					disabled={isConnectingGmail}
				>
					{isConnectingGmail
						? 'Opening...'
						: gmailStatus.data?.connected
							? 'Reconnect Gmail'
							: 'Connect Gmail'}
				</button>
				<button
					class="button button-outline"
					type="button"
					onclick={syncGmail}
					disabled={isSyncingGmail || !gmailStatus.data?.connected}
				>
					{isSyncingGmail ? 'Syncing...' : 'Sync Amazon'}
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
		<label class="search-field">
			<span>Search</span>
			<input type="search" bind:value={searchTerm} placeholder="Merchant, category, notes" />
		</label>
	</section>

	<section class="trend-section organic-surface" aria-label="Dynamic spending month over month">
		<div class="section-heading compact">
			<div>
				<p class="eyebrow">Dynamic · month over month</p>
				<h2>Unplanned spending trend</h2>
			</div>
			{#if monthlyBreakdown.data}
				<span class="sync-chip">{formatAmount(monthlyBreakdown.data.grandTotal)} over 12 mo</span>
			{/if}
		</div>

		{#if monthlyBreakdown.isLoading && !monthlyBreakdown.data}
			<div class="empty-state">Loading trend...</div>
		{:else}
			<div class="month-row">
				{#each monthlyMonths as entry (entry.month)}
					<button
						type="button"
						class="month-cell"
						class:is-active={entry.month === selectedMonth}
						title={`${formatMonthLong(entry.month)} · ${formatAmount(entry.total)}`}
						onclick={() => (selectedMonth = entry.month)}
					>
						<span class="month-bar-track">
							<span
								class="month-bar-fill"
								style={`height: ${maxMonthTotal > 0 ? Math.max(4, (entry.total / maxMonthTotal) * 100) : 4}%`}
							></span>
						</span>
						<b>{formatAmount(entry.total)}</b>
						<span class="month-label">{formatMonthShort(entry.month)}</span>
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<section class="summary-grid">
		<div class="organic-card">
			<span class="metric-label">Dynamic spend</span>
			<strong>{formatAmount(dynamicTotalMonthly)}</strong>
			<p>Unplanned spend in {formatMonthLong(selectedMonth)}</p>
		</div>
		<a class="organic-card card-link" href="/recurring">
			<span class="metric-label">Recurring</span>
			<strong>{recurringCount}</strong>
			<p>Merchant-rule rows in the selected period · view all →</p>
		</a>
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
					<p class="eyebrow">Dynamic · {formatMonthShort(selectedMonth)}</p>
					<h2>By category</h2>
				</div>
			</div>

			<div class="bar-list">
				{#each canonicalCategoryRows as row (row.slug)}
					<button
						type="button"
						class="bar-row"
						class:is-active={searchTerm === row.name}
						title={`Filter review queue by ${row.name}`}
						onclick={() => filterBySearch(row.name)}
					>
						<div>
							<strong>{row.name}</strong>
						</div>
						<b>{formatAmount(row.total)}</b>
					</button>
				{:else}
					<div class="empty-state">No categorized dynamic spend for this month.</div>
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
					<button
						type="button"
						class="bar-row"
						class:is-active={searchTerm === row.label}
						title={`Filter review queue by ${row.label}`}
						onclick={() => filterBySearch(row.label)}
					>
						<div>
							<strong>{row.label}</strong>
							<span>{row.count} rows</span>
						</div>
						<b>{formatAmount(row.total)}</b>
					</button>
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
				<div class="title-row">
					<h2>Review queue</h2>
					{#if activeFilters.length}
						<div class="filter-chips">
							{#each activeFilters as filter (filter.key)}
								<button
									type="button"
									class="filter-chip"
									onclick={filter.clear}
									aria-label={`Clear ${filter.label} filter`}
								>
									<span>{filter.label}</span>
									<span class="chip-x" aria-hidden="true">×</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
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
						<col class="amount-col" />
						<col class="actions-col" />
					</colgroup>
					<thead>
						<tr>
							<th>Date</th>
							<th>Merchant</th>
							<th>Category</th>
							<th
								class="amount-column"
								aria-sort={amountSort === 'asc'
									? 'ascending'
									: amountSort === 'desc'
										? 'descending'
										: 'none'}
							>
								<button type="button" class="sort-header" onclick={cycleAmountSort}>
									Amount
									<span class="sort-indicator" aria-hidden="true"
										>{amountSort === 'asc' ? '↑' : amountSort === 'desc' ? '↓' : '↕'}</span
									>
								</button>
							</th>
							<th>Set merchant rule</th>
						</tr>
					</thead>
					<tbody>
						{#each sortedTransactions as transaction (transaction.id)}
							<tr>
								<td data-label="Date">{transaction.date}</td>
								<td data-label="Merchant">
									{#if transaction.amazonItems && transaction.amazonItems.length}
										{#each transaction.amazonItems as item, i (i)}
											{@const short = truncateWords(item.title, 6)}
											<strong use:tooltip={short === item.title ? undefined : item.title}
												>{short}{#if item.quantity && item.quantity > 1}
													×{item.quantity}{/if}</strong
											>
										{/each}
										<span class="source-line"
											>Gmail · {transaction.merchantName ?? transaction.name}</span
										>
									{:else}
										{@const merchant = transaction.merchantName ?? transaction.name}
										<strong use:tooltip={merchant === transaction.name ? undefined : transaction.name}
											>{merchant}</strong
										>
										<span class="source-line">{transaction.source}</span>
									{/if}
									{#if transaction.pending}
										<span class="pending-chip">Pending</span>
									{/if}
								</td>
								<td data-label="Category">
									<div class="category-stack">
										<span>{displayCategory(transaction)}</span>
										{#if providerCategoryFor(transaction) && displayCategory(transaction) !== 'Uncategorized'}
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

	.hero-nav {
		margin-top: 1.25rem;
	}

	.nav-link {
		font-weight: 900;
		color: var(--color-primary);
		text-decoration: none;
	}

	.nav-link:hover {
		text-decoration: underline;
	}

	.card-link {
		display: block;
		color: inherit;
		text-decoration: none;
		transition:
			transform 220ms ease,
			box-shadow 220ms ease;
	}

	.card-link:hover {
		transform: translateY(-0.15rem);
		box-shadow: var(--shadow-soft);
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

	.panel-divider {
		height: 1px;
		margin: 1.5rem 0;
		background: rgb(222 216 207 / 70%);
	}

	.panel-sub {
		display: block;
		margin-top: 0.25rem;
		color: var(--color-muted-foreground);
		font-size: 0.9rem;
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
		grid-template-columns: minmax(10rem, 0.7fr) minmax(16rem, 2fr);
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

	input {
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

	.title-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}

	.filter-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.filter-chip {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		padding: 0.35rem 0.45rem 0.35rem 0.75rem;
		color: var(--color-primary);
		background: rgb(93 112 82 / 12%);
		border: 1px solid rgb(93 112 82 / 35%);
		border-radius: var(--radius-pill);
		font: inherit;
		font-size: 0.82rem;
		font-weight: 800;
		line-height: 1;
		cursor: pointer;
		transition: background-color 200ms ease;
	}

	.filter-chip:hover {
		background: rgb(93 112 82 / 22%);
	}

	.chip-x {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.15rem;
		height: 1.15rem;
		background: rgb(93 112 82 / 22%);
		border-radius: 50%;
		font-size: 1rem;
	}

	.sync-chip,
	.pending-chip {
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

	.trend-section {
		margin: 1rem 0 clamp(2rem, 5vw, 3.5rem);
		padding: 1.5rem;
		border-radius: 2rem 3.5rem 2rem 2.75rem;
	}

	.month-row {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(0, 1fr);
		gap: 0.4rem;
		align-items: end;
		margin-top: 1rem;
		overflow-x: auto;
	}

	.month-cell {
		display: grid;
		gap: 0.4rem;
		justify-items: center;
		min-width: 3.5rem;
		padding: 0.5rem 0.3rem;
		font: inherit;
		color: inherit;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 1rem;
		cursor: pointer;
		transition:
			background-color 200ms ease,
			border-color 200ms ease;
	}

	.month-cell:hover {
		background: rgb(230 220 205 / 45%);
	}

	.month-cell.is-active {
		background: rgb(93 112 82 / 12%);
		border-color: rgb(93 112 82 / 35%);
	}

	.month-bar-track {
		display: flex;
		align-items: end;
		justify-content: center;
		width: 100%;
		height: 5rem;
	}

	.month-bar-fill {
		display: block;
		width: 0.9rem;
		min-height: 0.25rem;
		background: var(--color-primary);
		border-radius: var(--radius-pill);
		opacity: 0.55;
	}

	.month-cell.is-active .month-bar-fill {
		opacity: 1;
	}

	.month-cell b {
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.month-label {
		color: var(--color-muted-foreground);
		font-size: 0.72rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
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
		width: 100%;
		margin: 0;
		padding: 0.5rem 0.65rem;
		font: inherit;
		color: inherit;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 1rem;
		cursor: pointer;
		transition:
			background-color 200ms ease,
			border-color 200ms ease;
	}

	.bar-row:hover {
		background: rgb(230 220 205 / 45%);
	}

	.bar-row.is-active {
		background: rgb(93 112 82 / 12%);
		border-color: rgb(93 112 82 / 35%);
	}

	.bar-row > div {
		min-width: 0;
	}

	.bar-row strong,
	.source-line {
		display: block;
	}

	.bar-row strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bar-row span,
	.source-line {
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
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
		width: 7rem;
	}

	.merchant-col {
		width: 26%;
	}

	.category-col {
		width: 28%;
	}

	.amount-col {
		width: 7rem;
	}

	.actions-col {
		width: 28%;
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

	.sort-header {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
		padding: 0;
		color: inherit;
		background: transparent;
		border: 0;
		font: inherit;
		font-size: 0.78rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.sort-header:hover {
		color: var(--color-primary);
	}

	.sort-indicator {
		font-size: 0.85rem;
	}

	th[aria-sort='ascending'] .sort-header,
	th[aria-sort='descending'] .sort-header {
		color: var(--color-primary);
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
