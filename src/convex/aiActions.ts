'use node';

import { action, env } from './_generated/server';
import { internal } from './_generated/api';
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// How many units (merchants + ASINs) to send in a single AI request. Bulk keeps cost/latency low.
const CHUNK_SIZE = 75;

type Unit =
	| { kind: 'merchant'; normalizedMerchant: string; name: string; plaidCategory: string }
	| { kind: 'asin'; asin: string; title: string };

// Resolve a provider-agnostic model handle. API keys come from the Convex environment
// (OPENAI_API_KEY / ANTHROPIC_API_KEY).
function resolveModel(provider: 'openai' | 'anthropic', model: string) {
	// The generated `Env` type only lists vars already set in the deployment; read through a
	// permissive view so an optional provider key is simply `undefined` when absent.
	const envVars = env as unknown as Record<string, string | undefined>;
	if (provider === 'anthropic') {
		const apiKey = envVars.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in the Convex environment.');
		return createAnthropic({ apiKey })(model);
	}
	const apiKey = envVars.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not set in the Convex environment.');
	return createOpenAI({ apiKey })(model);
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export const categorizeTransactions = action({
	args: {},
	handler: async (ctx): Promise<{ categorized: number; skipped: number; applied: number }> => {
		const input = await ctx.runQuery(internal.categories.getCategorizationInput, {});

		const units: Unit[] = [
			...input.merchantUnits.map((m) => ({ kind: 'merchant' as const, ...m })),
			...input.asinUnits.map((a) => ({ kind: 'asin' as const, ...a }))
		];

		if (units.length === 0) {
			return { categorized: 0, skipped: 0, applied: 0 };
		}

		const validSlugs = new Set(input.categories.map((c) => c.slug));
		const model = resolveModel(input.aiProvider, input.aiModel);
		const modelLabel = `${input.aiProvider}:${input.aiModel}`;

		const taxonomy = input.categories
			.map((c) => `- ${c.slug}: ${c.name}${c.description ? ` — ${c.description}` : ''}`)
			.join('\n');

		const schema = z.object({
			results: z.array(z.object({ index: z.number(), slug: z.string() }))
		});

		// Map each global unit index -> chosen slug (clamped to a known category).
		const slugByIndex = new Map<number, string>();

		for (const group of chunk(
			units.map((unit, index) => ({ unit, index })),
			CHUNK_SIZE
		)) {
			const lines = group.map(({ unit, index }) => {
				if (unit.kind === 'merchant') {
					const plaid = unit.plaidCategory ? `, plaid category "${unit.plaidCategory}"` : '';
					return `${index}. [merchant] "${unit.name}"${plaid}`;
				}
				return `${index}. [amazon item] "${unit.title}"`;
			});

			const { object } = await generateObject({
				model,
				schema,
				prompt:
					`You are categorizing personal spending. Assign each item below to exactly one ` +
					`category slug from this list:\n\n${taxonomy}\n\n` +
					`If nothing fits, use "uncategorized". Items:\n\n${lines.join('\n')}\n\n` +
					`Return one result per item using the numeric index shown.`
			});

			for (const result of object.results) {
				const slug = validSlugs.has(result.slug) ? result.slug : 'uncategorized';
				slugByIndex.set(result.index, slug);
			}
		}

		// Fold assignments back into merchant/ASIN buckets for a single write.
		const merchants: Array<{ normalizedMerchant: string; categorySlug: string }> = [];
		const asins: Array<{ asin: string; title?: string; categorySlug: string }> = [];
		let categorized = 0;
		let skipped = 0;

		units.forEach((unit, index) => {
			const slug = slugByIndex.get(index);
			if (!slug) {
				skipped += 1;
				return;
			}
			categorized += 1;
			if (unit.kind === 'merchant') {
				merchants.push({ normalizedMerchant: unit.normalizedMerchant, categorySlug: slug });
			} else {
				asins.push({ asin: unit.asin, title: unit.title, categorySlug: slug });
			}
		});

		const { applied } = await ctx.runMutation(internal.categories.saveCategoryAssignments, {
			model: modelLabel,
			merchants,
			asins
		});

		return { categorized, skipped, applied };
	}
});
