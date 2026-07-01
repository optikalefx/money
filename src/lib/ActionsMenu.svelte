<script lang="ts">
	import tippy, { type Instance } from 'tippy.js';
	import 'tippy.js/dist/tippy.css';

	let {
		disabled = false,
		showCategoryActions = true,
		onExpectedMerchant,
		onExpectedCategory,
		onIgnoreTransfer
	}: {
		disabled?: boolean;
		showCategoryActions?: boolean;
		onExpectedMerchant?: () => void;
		onExpectedCategory?: () => void;
		onIgnoreTransfer?: () => void;
	} = $props();

	let trigger: HTMLButtonElement;
	let menu: HTMLDivElement;

	function runAction(action: string | undefined) {
		switch (action) {
			case 'expected-merchant':
				onExpectedMerchant?.();
				break;
			case 'expected-category':
				onExpectedCategory?.();
				break;
			case 'ignore-transfer':
				onIgnoreTransfer?.();
				break;
		}
	}

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
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
			if (!button) return;
			instance.hide();
			runAction(button.dataset.action);
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
	<button type="button" data-action="expected-merchant">Expected merchant</button>
	{#if showCategoryActions}
		<button type="button" data-action="expected-category">Expected category</button>
		<button type="button" data-action="ignore-transfer">Ignore as transfer</button>
	{/if}
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
</style>
