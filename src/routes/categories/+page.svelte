<script lang="ts">
	import { onMount } from 'svelte';
	import { useAction, useMutation, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api.js';
	import { AI_MODELS, defaultModelFor, isAllowedModel } from '../../convex/aiModels';
	import type { Id } from '../../convex/_generated/dataModel.js';
	import SuggestionTransactions from '$lib/SuggestionTransactions.svelte';
	import Section from '$lib/Section.svelte';
	import ButtonWithActions from '$lib/ButtonWithActions.svelte';
	import Button from '$lib/Button.svelte';

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
	let isSuggesting = $state(false);
	let suggestionActionId = $state<string | null>(null);
	let expandedSuggestionId = $state<string | null>(null);
	// Member ids (`${kind}:${key}`) the user opted out of, per suggestion. Excluded units are
	// left Uncategorized when the suggestion is accepted.
	let excludedMembers = $state<Record<string, string[]>>({});
	let statusMessage = $state('');
	let errorMessage = $state('');

	const suggestionRows = $derived((suggestions.data ?? []) as Suggestion[]);

	// AI config: fall back to the saved value from the query until the user edits a field.
	let providerOverride = $state<'openai' | 'anthropic' | null>(null);
	let modelOverride = $state<string | null>(null);
	let savingConfig = $state(false);

	const provider = $derived(providerOverride ?? aiConfig.data?.aiProvider ?? 'openai');
	const modelOptions = $derived(AI_MODELS[provider]);
	// Snap to the provider's default when the saved model belongs to the other provider
	// (or predates the curated list).
	const savedModel = $derived(aiConfig.data?.aiModel ?? '');
	const model = $derived(
		modelOverride ?? (isAllowedModel(provider, savedModel) ? savedModel : defaultModelFor(provider))
	);
	const rows = $derived(
		[...((categories.data ?? []) as CategoryRow[])].sort((a, b) => a.name.localeCompare(b.name))
	);

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
			newName = '';
			newDescription = '';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to add category.';
			return;
		}
		// The new bucket may claim previously-uncategorized spend — sort it now.
		await categorizeUncategorized(false);
	}

	async function changeTreatment(row: CategoryRow, treatment: CategoryTreatment) {
		errorMessage = '';
		try {
			await setCategoryTreatment({ id: row.id, treatment });
			const label = treatment ?? 'dynamic';
			statusMessage = `${row.name} is now ${label}.`;
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

	// Run the AI over everything still uncategorized. Shared by the manual button and the
	// auto-runs after a new bucket appears (adding a category or accepting a suggestion) — that
	// bucket may claim spend that was previously clamped to Uncategorized.
	async function categorizeUncategorized(force: boolean) {
		isCategorizing = true;
		errorMessage = '';
		statusMessage = 'Categorizing transactions with AI...';
		try {
			const result = await categorize({ force });
			if (result.categorized === 0) {
				statusMessage =
					result.applied === 0
						? 'Nothing to categorize — everything is already cached.'
						: `Applied cached categories to ${result.applied} record${result.applied === 1 ? '' : 's'}.`;
			} else {
				statusMessage = `Categorized ${result.merchantUnits} merchant${result.merchantUnits === 1 ? '' : 's'} + ${result.itemUnits} item${result.itemUnits === 1 ? '' : 's'} in ${result.chunks} AI call${result.chunks === 1 ? '' : 's'}.`;
			}
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

	function toggleExcluded(suggestionId: string, memberId: string) {
		const current = excludedMembers[suggestionId] ?? [];
		excludedMembers[suggestionId] = current.includes(memberId)
			? current.filter((m) => m !== memberId)
			: [...current, memberId];
	}

	async function acceptOne(suggestion: Suggestion) {
		suggestionActionId = suggestion.id;
		errorMessage = '';
		try {
			await acceptSuggestion({
				id: suggestion.id,
				excludedMembers: excludedMembers[suggestion.id] ?? []
			});
			delete excludedMembers[suggestion.id];
			statusMessage = `Accepted ${suggestion.name}.`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to accept suggestion.';
			return;
		} finally {
			suggestionActionId = null;
		}
		// The accept mutation already moved this suggestion's members into the new bucket. A sweep can
		// still claim uncategorized spend that wasn't in the suggestion (units beyond the suggest cap,
		// or ones the model punted to "none"), so fire it in the background — the user needn't wait on
		// it, and the reactive queries update when it lands.
		categorize({ force: false }).catch(() => {});
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
				Plaid merchants and order items into them.
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
					onchange={(event) => {
						providerOverride = event.currentTarget.value as 'openai' | 'anthropic';
						modelOverride = null;
					}}
				>
					<option value="openai">OpenAI</option>
					<option value="anthropic">Anthropic</option>
				</select>
			</label>
			<label>
				<span>Model</span>
				<select value={model} onchange={(event) => (modelOverride = event.currentTarget.value)}>
					{#each modelOptions as option (option.id)}
						<option value={option.id}>{option.label}</option>
					{/each}
				</select>
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
			<div class="button-row">
				<Button
					variant="outline"
					onclick={runSuggest}
					loading={isSuggesting}
					loadingLabel="Thinking..."
				>
					Suggest categories
				</Button>
				<ButtonWithActions
					variant="primary"
					disabled={isCategorizing}
					title="Will categorize uncategorized transactions"
					onclick={() => categorizeUncategorized(false)}
					items={[
						{
							label: 'Re-run all (ignore cache)',
							onSelect: () => categorizeUncategorized(true)
						}
					]}
				>
					{isCategorizing ? 'Categorizing...' : 'Categorize transactions'}
				</ButtonWithActions>
			</div>
		</div>
	</section>

	{#if suggestionRows.length}
		<Section eyebrow="AI suggestions" title="New categories from your Uncategorized spend">
			<div class="suggestion-list">
				{#each suggestionRows as suggestion (suggestion.id)}
					{@const isExpanded = expandedSuggestionId === suggestion.id}
					{@const excludedCount = (excludedMembers[suggestion.id] ?? []).length}
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
								{#if excludedCount}
									<span class="excluded-note">{excludedCount} excluded</span>
								{/if}
							</div>
						</div>
						{#if isExpanded}
							<SuggestionTransactions
								id={suggestion.id}
								excluded={excludedMembers[suggestion.id] ?? []}
								onToggle={(memberId) => toggleExcluded(suggestion.id, memberId)}
							/>
						{/if}
					</article>
				{/each}
			</div>
		</Section>
	{/if}

	<Section eyebrow="New category" title="Add a category">
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
	</Section>

	<Section eyebrow="Your categories" title="Categories you already have">
		{#if categories.isLoading}
			<div class="empty-state">Loading categories...</div>
		{:else}
			<div class="category-table">
				<table>
					<thead>
						<tr>
							<th scope="col" class="name-col">Name</th>
							<th scope="col">AI guidance</th>
							<th scope="col" class="actions-col"></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.id)}
							{@const draft = draftFor(row)}
							<tr>
								<td class="name-cell">
									{#if row.slug === 'uncategorized'}
										<span class="fixed-name">{row.name}</span>
									{:else}
										<input
											type="text"
											value={draft.name}
											oninput={(event) => updateDraft(row, { name: event.currentTarget.value })}
										/>
									{/if}
									{#if row.treatment === 'expected'}
										<span class="treatment-tag">Expected</span>
									{/if}
								</td>
								<td class="desc-cell">
									<textarea
										rows="2"
										value={draft.description}
										oninput={(event) =>
											updateDraft(row, { description: event.currentTarget.value })}
										placeholder={row.isDefault ? 'Optional · default' : 'Optional'}
									></textarea>
								</td>
								<td class="actions-cell">
									<div class="cell-actions">
									{#if row.slug !== 'uncategorized'}
										<ButtonWithActions
											variant="outline"
											disabled={!isDirty(row) || savingId === row.id}
											onclick={() => saveRow(row)}
											items={[
												{
													label:
														row.treatment === 'expected'
															? 'Unmark as expected'
															: 'Mark as Expected',
													onSelect: () =>
														changeTreatment(row, row.treatment === 'expected' ? null : 'expected')
												},
												{ label: 'Delete', destructive: true, onSelect: () => removeCategory(row) }
											]}
										>
											{savingId === row.id ? 'Saving...' : 'Save'}
										</ButtonWithActions>
									{:else}
										<button
											type="button"
											class="button button-outline"
											disabled={!isDirty(row) || savingId === row.id}
											onclick={() => saveRow(row)}
										>
											{savingId === row.id ? 'Saving...' : 'Save'}
										</button>
									{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Section>
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

	.ai-panel {
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

	.button-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.suggestion-list {
		display: grid;
		gap: 1.25rem;
	}

	.suggestion-card {
		padding: 1.25rem 1.4rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
		box-shadow: var(--shadow-soft);
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

	.excluded-note {
		color: var(--color-muted-foreground);
		font-size: 0.75rem;
		font-weight: 800;
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

	.category-table {
		overflow-x: auto;
	}

	.category-table table {
		width: 100%;
		border-collapse: collapse;
	}

	.category-table thead th {
		padding: 0.4rem 0.75rem;
		color: var(--color-muted-foreground);
		font-size: 0.72rem;
		font-weight: 900;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		text-align: left;
	}

	.category-table tbody td {
		padding: 0.4rem 0.75rem;
		border-top: 1px solid rgb(222 216 207 / 55%);
		vertical-align: middle;
	}

	.category-table input,
	.category-table textarea {
		min-height: 2.3rem;
		padding: 0.4rem 0.7rem;
	}

	.category-table textarea {
		min-height: 2.3rem;
		border-radius: 0.75rem;
	}

	/* Fixed name + compact actions, so AI guidance takes all remaining width. */
	.name-col,
	.name-cell {
		width: 15rem;
	}

	/* Enforce the minimum on the input so table auto-layout can't collapse the column. */
	.name-cell input {
		min-width: 12rem;
	}

	/* The Uncategorized fallback name is fixed — shown as a label, not an editable input. */
	.fixed-name {
		display: inline-block;
		padding: 0.4rem 0.7rem;
		font-weight: 800;
	}

	.treatment-tag {
		display: block;
		margin-top: 0.3rem;
		margin-left: 0.2rem;
		color: var(--color-secondary);
		font-size: 0.75rem;
		font-style: italic;
		font-weight: 800;
	}

	.desc-cell {
		width: 100%;
	}

	.actions-cell {
		width: 1%;
		white-space: nowrap;
	}

	.cell-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		justify-content: flex-end;
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

	.button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		padding: 2rem;
		color: var(--color-muted-foreground);
	}

	@media (max-width: 760px) {
		.name-col,
		.name-cell,
		.desc-cell {
			width: auto;
			min-width: 8rem;
		}
	}
</style>
