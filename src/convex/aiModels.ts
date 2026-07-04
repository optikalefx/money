// Plain constants shared by the Convex backend and the frontend — no server imports here.
// Curated per-provider model lists, limited to the fast/low-cost tiers each vendor offers,
// since categorization runs in bulk. First entry is the default for its provider.
export const AI_MODELS = {
	openai: [
		{ id: 'gpt-5-nano', label: 'GPT-5 nano (fastest)' },
		{ id: 'gpt-5-mini', label: 'GPT-5 mini' },
		{ id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
		{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
		{ id: 'gpt-4o-mini', label: 'GPT-4o mini' }
	],
	anthropic: [
		{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest)' },
		{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }
	]
} as const;

export type AiProvider = keyof typeof AI_MODELS;

export function isAllowedModel(provider: AiProvider, model: string): boolean {
	return AI_MODELS[provider].some((m) => m.id === model);
}

export function defaultModelFor(provider: AiProvider): string {
	return AI_MODELS[provider][0].id;
}
