<script lang="ts">
	import { onMount } from 'svelte';
	import { useAction, useMutation, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api.js';
	import type { Id } from '../../convex/_generated/dataModel.js';
	import SuggestionTransactions from '$lib/SuggestionTransactions.svelte';

	type CategoryTreatment = 'expected' | 'transfer' | null;
	type CategoryRow = {
		id: Id<'categories'>;
		slug: string;
		name: string;
		description: string;
		treatment: CategoryTreatment;
		isDefault: boolean;
		sortOrder: number;
	};

	const categories = useQuery(api.categories.listCategories, () => ({}));
	const aiConfig = useQuery(api.categories.getAiConfig, () => ({}));
	const ensureDefaults = useMutation(api.categories.ensureDefaultCategories);
	const upsertCategory = useMutation(api.categories.upsertCategory);
	const deleteCategory = useMutation(api.categories.deleteCategory);
	const setCategoryTreatment = useMutation(api.categories.setCategoryTreatment);
	const setAiConfig = useMutation(api.categories.setAiConfig);
	const categorize = useAction(api.aiActions.categorizeTransactions);
	const suggestions = useQuery(api.categories.listCategorySuggestions, () => ({}));
	const suggestCategories = useAction(api.aiActions.suggestCategories);
	const acceptSuggestion = useMutation(api.categories.acceptCategorySuggestion);
	const dismissSuggestion = useMutation(api.categories.dismissCategorySuggestion);

	type Suggestion = {
		id: Id<'categorySuggestions'>;
		name: string;
		description: string;
		memberCount: number;
		weight: number;
		sampleTitles: string[];
	};

	let newName = $state('');
	let newDescription = $state('');
	let drafts = $state<Record<string, { name: string; description: string }>>({});
	let savingId = $state<string | null>(null);
	let isCategorizing = $state(false);
	let forceRun = $state(false);
	let isSuggesting = $state(false);
	let suggestionActionId = $state<string | null>(null);
	let expandedSuggestionId = $state<string | null>(null);
	let statusMessage = $state('');
	let errorMessage = $state('');

	const suggestionRows = $derived((suggestions.data ?? []) as Suggestion[]);

	// AI config: fall back to the saved value from the query until the user edits a field.
	let providerOverride = $state<'openai' | 'anthropic' | null>(null);
	let modelOverride = $state<string | null>(null);
	let savingConfig = $state(false);

	const provider = $derived(providerOverride ?? aiConfig.data?.aiProvider ?? 'openai');
	const model = $derived(modelOverride ?? aiConfig.data?.aiModel ?? '');
	const rows = $derived((categories.data ?? []) as CategoryRow[]);

	onMount(() => {
		ensureDefaults({}).catch(() => {});
	});

	function draftFor(row: CategoryRow) {
		return drafts[row.id] ?? { name: row.name, description: row.description };
	}

	function updateDraft(row: CategoryRow, patch: Partial<{ name: string; description: string }>) {
		drafts[row.id] = { ...draftFor(row), ...patch };
	}

	function isDirty(row: CategoryRow) {
		const draft = drafts[row.id];
		if (!draft) return false;
		return draft.name !== row.name || draft.description !== row.description;
	}

	async function saveRow(row: CategoryRow) {
		const draft = draftFor(row);
		savingId = row.id;
		errorMessage = '';
		try {
			await upsertCategory({ id: row.id, name: draft.name, description: draft.description });
			statusMessage = `Saved ${draft.name}.`;
			delete drafts[row.id];
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to save category.';
		} finally {
			savingId = null;
		}
	}

	async function addCategory() {
		if (!newName.trim()) return;
		errorMessage = '';
		try {
			await upsertCategory({ name: newName, description: newDescription });
			statusMessage = `Added ${newName.trim()}.`;
			newName = '';
			newDescription = '';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to add category.';
		}
	}

	async function changeTreatment(row: CategoryRow, treatment: CategoryTreatment) {
		errorMessage = '';
		try {
			const result = await setCategoryTreatment({ id: row.id, treatment });
			const label = treatment ?? 'dynamic';
			statusMessage = `${row.name} is now ${label} (${result.updated} transaction${
				result.updated === 1 ? '' : 's'
			} reclassified).`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to update treatment.';
		}
	}

	async function removeCategory(row: CategoryRow) {
		errorMessage = '';
		try {
			await deleteCategory({ id: row.id });
			statusMessage = `Removed ${row.name}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to delete category.';
		}
	}

	async function saveConfig() {
		savingConfig = true;
		errorMessage = '';
		try {
			await setAiConfig({ aiProvider: provider, aiModel: model });
			statusMessage = `AI set to ${provider} · ${model}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to save AI settings.';
		} finally {
			savingConfig = false;
		}
	}

	async function runCategorize() {
		isCategorizing = true;
		errorMessage = '';
		statusMessage = 'Categorizing transactions with AI...';
		try {
			const result = await categorize({ force: forceRun });
			statusMessage =
				result.categorized === 0
					? 'Nothing to categorize — everything is already cached.'
					: `Categorized ${result.merchantUnits} merchant${result.merchantUnits === 1 ? '' : 's'} + ${result.asinUnits} Amazon item${result.asinUnits === 1 ? '' : 's'} in ${result.chunks} AI call${result.chunks === 1 ? '' : 's'}, applied to ${result.applied} record${result.applied === 1 ? '' : 's'}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to categorize.';
		} finally {
			isCategorizing = false;
		}
	}

	async function runSuggest() {
		isSuggesting = true;
		errorMessage = '';
		statusMessage = 'Asking the AI for new category ideas...';
		try {
			const result = await suggestCategories({});
			statusMessage =
				result.suggested === 0
					? result.uncategorizedUnits === 0
						? 'Nothing uncategorized — no suggestions needed.'
						: 'The AI had no new categories to suggest.'
					: `${result.suggested} suggestion${result.suggested === 1 ? '' : 's'} from ${result.consideredUnits} uncategorized item${result.consideredUnits === 1 ? '' : 's'}. Review below.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to suggest categories.';
		} finally {
			isSuggesting = false;
		}
	}

	async function acceptOne(suggestion: Suggestion) {
		suggestionActionId = suggestion.id;
		errorMessage = '';
		try {
			const result = await acceptSuggestion({ id: suggestion.id });
			statusMessage = `Added ${suggestion.name} and moved ${result.applied} record${result.applied === 1 ? '' : 's'} into it.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to accept suggestion.';
		} finally {
			suggestionActionId = null;
		}
	}

	async function dismissOne(suggestion: Suggestion) {
		suggestionActionId = suggestion.id;
		errorMessage = '';
		try {
			await dismissSuggestion({ id: suggestion.id });
			statusMessage = `Dismissed ${suggestion.name}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to dismiss suggestion.';
		} finally {
			suggestionActionId = null;
		}
	}
</script>

<svelte:head>
	<title>Categories · Money Tracker</title>
	<meta
		name="description"
		content="Define the AI categories used to break down dynamic spending."
	/>
</svelte:head>

<main class="money-shell">
	<section class="page-heading">
		<div>
			<p class="eyebrow"><a class="back-link" href="/">← Back to review</a></p>
			<h1>Categories</h1>
			<p class="lede">
				These categories power the month-over-month breakdown. Every category is AI-driven — the
				description tells the AI how to decide a transaction belongs here (leave it blank when the
				name says it all). Run <strong>Categorize transactions</strong> to have the AI sort your dynamic
				Plaid merchants and Amazon items into them.
			</p>
		</div>
	</section>

	{#if statusMessage}
		<p class="status-note">{statusMessage}</p>
	{/if}
	{#if errorMessage}
		<p class="error-note">{errorMessage}</p>
	{/if}

	<section class="ai-panel organic-surface">
		<div class="ai-config">
			<label>
				<span>AI provider</span>
				<select
					value={provider}
					onchange={(event) =>
						(providerOverride = event.currentTarget.value as 'openai' | 'anthropic')}
				>
					<option value="openai">OpenAI</option>
					<option value="anthropic">Anthropic</option>
				</select>
			</label>
			<label>
				<span>Model</span>
				<input
					type="text"
					value={model}
					oninput={(event) => (modelOverride = event.currentTarget.value)}
					placeholder="gpt-4o-mini"
				/>
			</label>
			<button
				class="button button-outline"
				type="button"
				onclick={saveConfig}
				disabled={savingConfig}
			>
				{savingConfig ? 'Saving...' : 'Save AI settings'}
			</button>
		</div>
		<div class="categorize-actions">
			<label class="force-toggle">
				<input type="checkbox" bind:checked={forceRun} />
				<span>Re-run all (ignore cache)</span>
			</label>
			<div class="button-row">
				<button
					class="button button-outline"
					type="button"
					onclick={runSuggest}
					disabled={isSuggesting}
				>
					{isSuggesting ? 'Thinking...' : 'Suggest categories'}
				</button>
				<button
					class="button button-primary"
					type="button"
					onclick={runCategorize}
					disabled={isCategorizing}
				>
					{isCategorizing ? 'Categorizing...' : 'Categorize transactions'}
				</button>
			</div>
		</div>
	</section>

	{#if suggestionRows.length}
		<section class="suggest-panel organic-surface">
			<div class="section-heading">
				<div>
					<p class="eyebrow">AI suggestions</p>
					<h2>New categories from your Uncategorized spend</h2>
				</div>
			</div>
			<div class="suggestion-list">
				{#each suggestionRows as suggestion (suggestion.id)}
					{@const isExpanded = expandedSuggestionId === suggestion.id}
					<article class="suggestion-card">
						<div class="suggestion-head">
							<div class="suggestion-main">
								<div class="suggestion-title">
									<strong>{suggestion.name}</strong>
									<span class="suggestion-count"
										>{suggestion.weight} txn{suggestion.weight === 1 ? '' : 's'} · {suggestion.memberCount}
										merchant/item{suggestion.memberCount === 1 ? '' : 's'}</span
									>
								</div>
								{#if suggestion.description}
									<p class="suggestion-desc">{suggestion.description}</p>
								{/if}
								{#if suggestion.sampleTitles.length && !isExpanded}
									<p class="suggestion-samples">e.g. {suggestion.sampleTitles.join(', ')}</p>
								{/if}
								<button
									type="button"
									class="text-action expand-toggle"
									aria-expanded={isExpanded}
									onclick={() =>
										(expandedSuggestionId = isExpanded ? null : suggestion.id)}
								>
									{isExpanded ? 'Hide transactions ▾' : 'Show transactions ▸'}
								</button>
							</div>
							<div class="suggestion-actions">
								<button
									type="button"
									class="button button-primary"
									disabled={suggestionActionId === suggestion.id}
									onclick={() => acceptOne(suggestion)}
								>
									Accept
								</button>
								<button
									type="button"
									class="text-action"
									disabled={suggestionActionId === suggestion.id}
									onclick={() => dismissOne(suggestion)}
								>
									Dismiss
								</button>
							</div>
						</div>
						{#if isExpanded}
							<SuggestionTransactions id={suggestion.id} />
						{/if}
					</article>
				{/each}
			</div>
		</section>
	{/if}

	<section class="add-panel organic-surface">
		<h2>Add a category</h2>
		<div class="add-row">
			<label>
				<span>Name</span>
				<input type="text" bind:value={newName} placeholder="e.g. Business" />
			</label>
			<label class="grow">
				<span>Description (AI guidance)</span>
				<input
					type="text"
					bind:value={newDescription}
					placeholder="Optional — how the AI should recognize this category"
				/>
			</label>
			<button
				class="button button-primary"
				type="button"
				onclick={addCategory}
				disabled={!newName.trim()}
			>
				Add
			</button>
		</div>
	</section>

	<section class="list-section">
		{#if categories.isLoading}
			<div class="empty-state">Loading categories...</div>
		{:else}
			<div class="category-list">
				{#each rows as row (row.id)}
					{@const draft = draftFor(row)}
					<article class="category-card organic-surface">
						<div class="card-main">
							<label class="name-field">
								<span>Name</span>
								<input
									type="text"
									value={draft.name}
									oninput={(event) => updateDraft(row, { name: event.currentTarget.value })}
								/>
							</label>
							<label class="desc-field">
								<span
									>AI guidance {#if row.isDefault}<em>· default</em>{/if}</span
								>
								<textarea
									rows="2"
									value={draft.description}
									oninput={(event) => updateDraft(row, { description: event.currentTarget.value })}
									placeholder="Optional"></textarea>
							</label>
							{#if row.slug !== 'uncategorized'}
								<label class="treatment-field">
									<span>Treatment</span>
									<select
										value={row.treatment ?? 'dynamic'}
										onchange={(event) =>
											changeTreatment(
												row,
												event.currentTarget.value === 'dynamic'
													? null
													: (event.currentTarget.value as CategoryTreatment)
											)}
									>
										<option value="dynamic">Dynamic</option>
										<option value="expected">Expected</option>
										<option value="transfer">Transfer (ignore)</option>
									</select>
								</label>
							{/if}
						</div>
						<div class="card-actions">
							<button
								type="button"
								class="button button-outline"
								disabled={!isDirty(row) || savingId === row.id}
								onclick={() => saveRow(row)}
							>
								{savingId === row.id ? 'Saving...' : 'Save'}
							</button>
							{#if row.slug !== 'uncategorized'}
								<button
									type="button"
									class="text-action delete"
									onclick={() => removeCategory(row)}
								>
									Delete
								</button>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</main>

<style>
	.money-shell {
		width: var(--container-page);
		margin-inline: auto;
		padding: clamp(2rem, 6vw, 4rem) 0;
	}

	.page-heading {
		margin-bottom: 2rem;
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

	.back-link {
		color: var(--color-primary);
		text-decoration: none;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	.lede {
		max-width: 48rem;
		color: var(--color-muted-foreground);
		font-size: clamp(1rem, 2vw, 1.15rem);
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

	.ai-panel,
	.add-panel {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
		justify-content: space-between;
		margin-bottom: 1.25rem;
		padding: 1.25rem 1.5rem;
		border-radius: 1.5rem 2.5rem 1.5rem 2rem;
	}

	.ai-config {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
	}

	.categorize-actions {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: end;
	}

	.force-toggle {
		display: flex;
		flex-direction: row;
		gap: 0.45rem;
		align-items: center;
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
		font-weight: 800;
	}

	.force-toggle input {
		width: auto;
		min-height: 0;
		margin: 0;
	}

	.button-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.suggest-panel {
		margin-bottom: 1.25rem;
		padding: 1.5rem;
		border-radius: 2rem 3.5rem 2rem 2.75rem;
	}

	.section-heading {
		margin-bottom: 1.25rem;
	}

	.section-heading h2 {
		margin: 0.25rem 0 0;
		font-size: clamp(1.3rem, 3vw, 1.8rem);
	}

	.suggestion-list {
		display: grid;
		gap: 1rem;
	}

	.suggestion-card {
		padding: 1.1rem 1.25rem;
		background: rgb(254 254 250 / 82%);
		border: 1px solid rgb(222 216 207 / 70%);
		border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
	}

	.suggestion-head {
		display: flex;
		gap: 1.5rem;
		align-items: center;
		justify-content: space-between;
	}

	.expand-toggle {
		margin-top: 0.5rem;
		color: var(--color-primary);
	}

	.suggestion-main {
		min-width: 0;
	}

	.suggestion-title {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		align-items: baseline;
	}

	.suggestion-title strong {
		font-size: 1.15rem;
		font-weight: 900;
	}

	.suggestion-count {
		color: var(--color-primary);
		font-size: 0.8rem;
		font-weight: 800;
	}

	.suggestion-desc {
		margin: 0.35rem 0 0;
		color: var(--color-foreground);
		font-size: 0.92rem;
	}

	.suggestion-samples {
		margin: 0.3rem 0 0;
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
	}

	.suggestion-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: end;
	}

	@media (max-width: 640px) {
		.suggestion-head {
			flex-direction: column;
			align-items: stretch;
		}

		.suggestion-actions {
			flex-direction: row;
			align-items: center;
		}
	}

	.add-panel {
		display: block;
	}

	.add-panel h2 {
		margin: 0 0 0.75rem;
		font-size: 1.2rem;
	}

	.add-row {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
	}

	label {
		display: grid;
		gap: 0.35rem;
		color: var(--color-muted-foreground);
		font-size: 0.82rem;
		font-weight: 800;
	}

	label.grow {
		flex: 1;
		min-width: 16rem;
	}

	input,
	select,
	textarea {
		width: 100%;
		min-height: 2.7rem;
		padding: 0.6rem 0.8rem;
		color: var(--color-foreground);
		background: rgb(254 254 250 / 82%);
		border: 1px solid rgb(222 216 207 / 80%);
		border-radius: var(--radius-pill);
		font: inherit;
	}

	textarea {
		border-radius: 1rem;
		resize: vertical;
	}

	.category-list {
		display: grid;
		gap: 1rem;
	}

	.category-card {
		display: flex;
		gap: 1.5rem;
		align-items: stretch;
		justify-content: space-between;
		padding: 1.25rem 1.5rem;
		border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
	}

	.card-main {
		display: grid;
		grid-template-columns: minmax(10rem, 0.5fr) minmax(0, 1.5fr);
		gap: 1rem;
		flex: 1;
	}

	.desc-field span em {
		color: var(--color-primary);
		font-style: normal;
		font-weight: 900;
	}

	.card-actions {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: end;
		justify-content: center;
	}

	.text-action {
		padding: 0;
		color: var(--color-muted-foreground);
		background: transparent;
		border: 0;
		font-size: 0.78rem;
		font-weight: 900;
		text-decoration: underline;
		cursor: pointer;
	}

	.text-action.delete:hover {
		color: var(--color-destructive);
	}

	.button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		padding: 2rem;
		color: var(--color-muted-foreground);
	}

	@media (max-width: 760px) {
		.category-card,
		.card-main {
			flex-direction: column;
			grid-template-columns: 1fr;
		}

		.card-actions {
			flex-direction: row;
			align-items: center;
			justify-content: flex-start;
		}
	}
</style>
