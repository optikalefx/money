import type { Action } from 'svelte/action';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';

// Svelte action: attach a hover tooltip. Pass the full text as the parameter, or undefined/empty
// to disable (e.g. when the displayed text isn't truncated and a tooltip would be redundant).
export const tooltip: Action<HTMLElement, string | undefined> = (node, content) => {
	const instance = tippy(node, {
		content: content ?? '',
		delay: [150, 0],
		maxWidth: 360
	});
	if (!content) instance.disable();

	return {
		update(next) {
			instance.setContent(next ?? '');
			if (next) instance.enable();
			else instance.disable();
		},
		destroy() {
			instance.destroy();
		}
	};
};

// Keep the first `count` words; append an ellipsis if anything was trimmed.
export function truncateWords(text: string, count: number): string {
	const words = text.split(/\s+/);
	if (words.length <= count) return text;
	return `${words.slice(0, count).join(' ')}…`;
}
