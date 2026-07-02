<script lang="ts">
	import tippy, { type Instance } from 'tippy.js';
	import 'tippy.js/dist/tippy.css';

	type ActionItem = {
		label: string;
		onSelect: () => void;
		destructive?: boolean;
		active?: boolean;
	};

	let {
		disabled = false,
		showCategoryActions = true,
		items,
		onExpectedMerchant,
		onExpectedCategory,
		onIgnoreTransfer
	}: {
		disabled?: boolean;
		showCategoryActions?: boolean;
		items?: ActionItem[];
		onExpectedMerchant?: () => void;
		onExpectedCategory?: () => void;
		onIgnoreTransfer?: () => void;
	} = $props();

	// Fall back to the legacy named-callback API when no explicit `items` are passed.
	const resolvedItems = $derived<ActionItem[]>(
		items ?? [
			{ label: 'Expected merchant', onSelect: () => onExpectedMerchant?.() },
			...(showCategoryActions
				? [
						{ label: 'Expected category', onSelect: () => onExpectedCategory?.() },
						{ label: 'Ignore as transfer', onSelect: () => onIgnoreTransfer?.() }
					]
				: [])
		]
	);

	let trigger: HTMLButtonElement;
	let menu: HTMLDivElement;

	$effect(() => {
		const instance: Instance = tippy(trigger, {
			content: menu,
			trigger: 'click',
			interactive: true,
			appendTo: () => document.body,
			placement: 'bottom-end',
			arrow: false,
			offset: [0, 6],
			theme: 'actions-menu'
		});
		menu.hidden = false;

		// tippy moves `menu` under document.body, outside Svelte's delegated event root,
		// so wire the clicks up manually rather than relying on Svelte onclick handlers.
		const handleClick = (event: MouseEvent) => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-index]');
			if (!button) return;
			instance.hide();
			// Read the live derived list at click time so the latest handlers/labels win.
			resolvedItems[Number(button.dataset.index)]?.onSelect();
		};
		menu.addEventListener('click', handleClick);

		return () => {
			menu.removeEventListener('click', handleClick);
			instance.destroy();
		};
	});
</script>

<button bind:this={trigger} type="button" class="actions-trigger" {disabled}>Actions</button>

<div bind:this={menu} class="actions-menu" hidden>
	{#each resolvedItems as item, index (index)}
		<button type="button" data-index={index} class:destructive={item.destructive}>
			{#if item.active}<span class="check" aria-hidden="true">✓</span>{/if}{item.label}
		</button>
	{/each}
</div>

<style>
	.actions-trigger {
		width: 100%;
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

	.actions-trigger:hover {
		transform: translateY(-0.08rem);
		background: rgb(230 220 205 / 78%);
	}

	.actions-trigger:disabled {
		cursor: not-allowed;
		opacity: 0.58;
		transform: none;
	}

	.actions-menu {
		display: grid;
		gap: 0.15rem;
		min-width: 11rem;
		padding: 0.3rem;
	}

	.actions-menu button {
		width: 100%;
		padding: 0.5rem 0.6rem;
		color: var(--color-accent-foreground);
		background: transparent;
		border: 0;
		border-radius: var(--radius-md, 0.5rem);
		font-size: 0.78rem;
		font-weight: 800;
		text-align: left;
		cursor: pointer;
	}

	.actions-menu button:hover {
		background: rgb(230 220 205 / 55%);
	}

	.actions-menu button.destructive {
		color: var(--color-destructive);
	}

	.actions-menu .check {
		margin-right: 0.35rem;
		color: var(--color-primary);
		font-weight: 900;
	}
</style>
