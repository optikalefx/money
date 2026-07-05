<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = false,
		title,
		onClose,
		children,
		footer
	}: {
		/** Controls visibility. Two-way bindable so the modal can close itself. */
		open?: boolean;
		/** Heading shown in the modal header. */
		title?: string;
		/** Called whenever the modal closes (backdrop click, Escape, or the ✕). */
		onClose?: () => void;
		/** Body content. */
		children: Snippet;
		/** Optional footer (actions) rendered below the body. */
		footer?: Snippet;
	} = $props();

	let dialog: HTMLDialogElement;

	// Drive the native <dialog> from the `open` prop so callers control it declaratively while we
	// still get focus trapping, Escape handling, and the top layer for free.
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});

	function close() {
		open = false;
		onClose?.();
	}

	// Fires on Escape (native) and on dialog.close(); keep `open` in sync either way.
	function handleClose() {
		if (open) close();
	}

	// A click that lands on the <dialog> element itself (not its content wrapper) is a backdrop click.
	function handleClick(event: MouseEvent) {
		if (event.target === dialog) close();
	}
</script>

<dialog bind:this={dialog} class="modal" onclose={handleClose} onclick={handleClick}>
	<div class="modal-panel">
		<header class="modal-head">
			{#if title}<h2>{title}</h2>{/if}
			<button type="button" class="modal-close" aria-label="Close" onclick={close}>✕</button>
		</header>
		<div class="modal-body">
			{@render children()}
		</div>
		{#if footer}
			<footer class="modal-foot">
				{@render footer()}
			</footer>
		{/if}
	</div>
</dialog>

<style>
	.modal {
		width: min(30rem, calc(100vw - 2rem));
		max-width: 30rem;
		padding: 0;
		color: var(--color-foreground);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 1.4rem 2.2rem 1.5rem 1.9rem;
		box-shadow: var(--shadow-soft);
	}

	.modal::backdrop {
		background: rgb(40 34 28 / 42%);
		backdrop-filter: blur(2px);
	}

	.modal-panel {
		display: grid;
		gap: 1.1rem;
		padding: 1.5rem 1.6rem;
	}

	.modal-head {
		display: flex;
		gap: 1rem;
		align-items: start;
		justify-content: space-between;
	}

	.modal-head h2 {
		margin: 0;
		font-size: 1.2rem;
		font-weight: 900;
	}

	.modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		color: var(--color-muted-foreground);
		background: transparent;
		border: 0;
		border-radius: 50%;
		font-size: 1rem;
		cursor: pointer;
	}

	.modal-close:hover {
		background: rgb(230 220 205 / 55%);
	}

	.modal-body {
		font-size: 0.95rem;
	}

	.modal-foot {
		display: flex;
		gap: 0.6rem;
		justify-content: flex-end;
	}
</style>
