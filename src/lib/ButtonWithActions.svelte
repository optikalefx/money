<script lang="ts">
	import type { Snippet } from 'svelte';
	import tippy, { type Instance } from 'tippy.js';
	import 'tippy.js/dist/tippy.css';

	type ActionItem = {
		label: string;
		onSelect: () => void;
		destructive?: boolean;
		active?: boolean;
	};

	let {
		variant = 'primary',
		type = 'button',
		disabled = false,
		mainDisabled = false,
		title,
		onclick,
		items,
		menuLabel = 'More actions',
		class: className = '',
		children
	}: {
		variant?: 'primary' | 'outline' | 'soft';
		type?: 'button' | 'submit' | 'reset';
		/** Disables the whole control (both the primary segment and the ⋯ menu). */
		disabled?: boolean;
		/** Disables only the primary segment; the ⋯ menu stays usable. */
		mainDisabled?: boolean;
		/** Tooltip for the primary segment. */
		title?: string;
		/** Fired when the primary (left) segment is clicked. */
		onclick?: (event: MouseEvent) => void;
		/** Popover menu entries opened by the trailing ⋯ segment. */
		items: ActionItem[];
		/** Accessible label for the ⋯ segment. */
		menuLabel?: string;
		class?: string;
		children: Snippet;
	} = $props();

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

		// tippy relocates `menu` under document.body, outside Svelte's delegated event
		// root, so wire the clicks up manually rather than via Svelte onclick handlers.
		const handleClick = (event: MouseEvent) => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-index]');
			if (!button) return;
			instance.hide();
			// Read the live prop at click time so the latest handlers/labels win.
			items[Number(button.dataset.index)]?.onSelect();
		};
		menu.addEventListener('click', handleClick);

		return () => {
			menu.removeEventListener('click', handleClick);
			instance.destroy();
		};
	});
</script>

<div class="bwa bwa-{variant} {className}" class:is-disabled={disabled}>
	<button class="bwa-main" {type} disabled={disabled || mainDisabled} {title} {onclick}>
		{@render children()}
	</button>
	<span class="bwa-divider" aria-hidden="true"></span>
	<button
		bind:this={trigger}
		type="button"
		class="bwa-more"
		{disabled}
		aria-label={menuLabel}
		aria-haspopup="menu"
	>
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
			<circle cx="4" cy="10" r="1.6" fill="currentColor" />
			<circle cx="10" cy="10" r="1.6" fill="currentColor" />
			<circle cx="16" cy="10" r="1.6" fill="currentColor" />
		</svg>
	</button>
</div>

<div bind:this={menu} class="actions-menu" hidden>
	{#each items as item, index (index)}
		<button type="button" data-index={index} class:destructive={item.destructive}>
			{#if item.active}<span class="check" aria-hidden="true">✓</span>{/if}{item.label}
		</button>
	{/each}
</div>

<style>
	.bwa {
		display: inline-flex;
		align-items: stretch;
		border-radius: var(--radius-pill);
		isolation: isolate;
	}

	.bwa button {
		min-width: 0;
		border: 0;
		font-weight: 800;
		line-height: 1.05;
		cursor: pointer;
		transition:
			background-color 220ms ease,
			color 220ms ease,
			opacity 220ms ease;
	}

	/* Left segment carries the pill's left corners; ⋯ segment carries the right. */
	.bwa-main {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-top-left-radius: var(--radius-pill);
		border-bottom-left-radius: var(--radius-pill);
	}

	.bwa-more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding-inline: 0.55rem;
		border-top-right-radius: var(--radius-pill);
		border-bottom-right-radius: var(--radius-pill);
	}

	.bwa-more svg {
		display: block;
	}

	/* Hairline seam between the two segments. */
	.bwa-divider {
		width: 1px;
		align-self: stretch;
		margin-block: 0.35rem;
	}

	.bwa.is-disabled {
		opacity: 0.58;
	}

	.bwa.is-disabled button {
		cursor: not-allowed;
	}

	/* When only the primary segment is disabled (mainDisabled), fade just it — the ⋯ stays live. */
	.bwa:not(.is-disabled) .bwa-main:disabled {
		cursor: not-allowed;
		opacity: 0.58;
	}

	/* ---- primary: solid green pill ---- */
	.bwa-primary {
		box-shadow: var(--shadow-soft);
	}

	.bwa-primary .bwa-main {
		min-height: 3rem;
		padding: 0.75rem 1.5rem;
		color: var(--color-primary-foreground);
		background: var(--color-primary);
	}

	.bwa-primary .bwa-more {
		color: var(--color-primary-foreground);
		background: var(--color-primary);
	}

	.bwa-primary .bwa-divider {
		background: rgb(255 255 255 / 28%);
	}

	.bwa-primary:not(.is-disabled) .bwa-main:not(:disabled):hover {
		background: color-mix(in srgb, var(--color-primary) 92%, black);
	}

	.bwa-primary:not(.is-disabled) .bwa-more:hover {
		background: color-mix(in srgb, var(--color-primary) 78%, black);
	}

	/* ---- outline: bordered pill ---- */
	.bwa-outline {
		border: 2px solid var(--color-secondary);
	}

	.bwa-outline .bwa-main {
		min-height: 3rem;
		padding: 0.75rem 1.5rem;
		color: var(--color-secondary);
		background: transparent;
	}

	.bwa-outline .bwa-more {
		color: var(--color-secondary);
		background: transparent;
	}

	.bwa-outline .bwa-divider {
		background: var(--color-secondary);
		opacity: 0.4;
	}

	.bwa-outline:not(.is-disabled) .bwa-main:not(:disabled):hover {
		color: var(--color-secondary-foreground);
		background: color-mix(in srgb, var(--color-secondary) 85%, transparent);
	}

	.bwa-outline:not(.is-disabled) .bwa-more:hover {
		color: var(--color-secondary-foreground);
		background: var(--color-secondary);
	}

	/* ---- soft: compact tan pill (Review table density) ---- */
	.bwa-soft {
		border: 1px solid rgb(222 216 207 / 80%);
		background: rgb(230 220 205 / 50%);
	}

	.bwa-soft .bwa-main {
		min-height: 2.1rem;
		padding: 0.45rem 0.75rem;
		color: var(--color-accent-foreground);
		background: transparent;
		font-size: 0.68rem;
		font-weight: 900;
	}

	.bwa-soft .bwa-more {
		color: var(--color-accent-foreground);
		background: transparent;
	}

	.bwa-soft .bwa-divider {
		background: rgb(222 216 207 / 90%);
	}

	.bwa-soft:not(.is-disabled) .bwa-main:not(:disabled):hover {
		background: rgb(230 220 205 / 78%);
	}

	.bwa-soft:not(.is-disabled) .bwa-more:hover {
		background: rgb(210 197 176 / 92%);
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
