'use node';

import { v } from 'convex/values';
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
	args: { force: v.optional(v.boolean()) },
	handler: async (
		ctx,
		args
	): Promise<{
		categorized: number;
		skipped: number;
		applied: number;
		cacheApplied: number;
		merchantUnits: number;
		asinUnits: number;
		chunks: number;
	}> => {
		const input = await ctx.runQuery(internal.categories.getCategorizationInput, {
			force: args.force ?? false
		});

		// Merchants/ASINs that already have a cached category but still have uncategorized
		// transactions: apply the cached slug directly, no AI call needed.
		let cacheApplied = 0;
		if (input.cachedMerchants.length > 0 || input.cachedAsins.length > 0) {
			const res = await ctx.runMutation(internal.categories.saveCategoryAssignments, {
				merchants: input.cachedMerchants,
				asins: input.cachedAsins
			});
			cacheApplied = res.applied;
			console.log(
				`[categorize] applied cached categories to ${cacheApplied} record(s) from ` +
					`${input.cachedMerchants.length} merchant(s) + ${input.cachedAsins.length} ASIN(s).`
			);
		}

		const units: Unit[] = [
			...input.merchantUnits.map((m) => ({ kind: 'merchant' as const, ...m })),
			...input.asinUnits.map((a) => ({ kind: 'asin' as const, ...a }))
		];

		if (units.length === 0) {
			console.log('[categorize] no new merchants/ASINs need the AI.');
			return {
				categorized: 0,
				skipped: 0,
				applied: cacheApplied,
				cacheApplied,
				merchantUnits: 0,
				asinUnits: 0,
				chunks: 0
			};
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

		const groups = chunk(
			units.map((unit, index) => ({ unit, index })),
			CHUNK_SIZE
		);
		console.log(
			`[categorize] model=${modelLabel} · ${input.merchantUnits.length} merchants + ` +
				`${input.asinUnits.length} ASINs = ${units.length} distinct units in ${groups.length} chunk(s).`
		);

		// Map each global unit index -> chosen slug (clamped to a known category).
		const slugByIndex = new Map<number, string>();

		for (let chunkIndex = 0; chunkIndex < groups.length; chunkIndex++) {
			const group = groups[chunkIndex];
			const lines = group.map(({ unit, index }) => {
				if (unit.kind === 'merchant') {
					const plaid = unit.plaidCategory ? `, plaid category "${unit.plaidCategory}"` : '';
					return `${index}. [merchant] "${unit.name}"${plaid}`;
				}
				return `${index}. [amazon item] "${unit.title}"`;
			});

			const prompt =
				`You are categorizing personal spending. Assign each item below to exactly one ` +
				`category slug from this list:\n\n${taxonomy}\n\n` +
				`If nothing fits, use "uncategorized". Items:\n\n${lines.join('\n')}\n\n` +
				`Return one result per item using the numeric index shown.`;

			const { object, usage } = await generateObject({ model, schema, prompt });

			// Log the full prompt + response so it's visible in `npx convex logs` / the dashboard.
			console.log(
				`[categorize] chunk ${chunkIndex + 1}/${groups.length} (${group.length} units) usage=${JSON.stringify(usage)}\n--- PROMPT ---\n${prompt}\n--- RESPONSE ---\n${JSON.stringify(object.results)}`
			);
			// And persist it durably for later inspection via categories:listAiRuns.
			await ctx.runMutation(internal.categories.recordAiRun, {
				kind: 'categorization',
				model: modelLabel,
				chunkIndex,
				chunkCount: groups.length,
				unitCount: group.length,
				prompt,
				results: object.results,
				usage
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

		console.log(
			`[categorize] done — ${categorized} units categorized, applied to ${applied} record(s).`
		);
		return {
			categorized,
			skipped,
			applied: applied + cacheApplied,
			cacheApplied,
			merchantUnits: input.merchantUnits.length,
			asinUnits: input.asinUnits.length,
			chunks: groups.length
		};
	}
});

// Cap how many uncategorized units we show the model in one shot, and how many new
// categories it may propose.
const MAX_SUGGEST_UNITS = 200;
const MAX_SUGGESTIONS = 8;

// Look at everything currently in "Uncategorized" and propose new categories that would cover
// it, grouping each uncategorized merchant/item under a proposal so we can show projected counts.
export const suggestCategories = action({
	args: {},
	handler: async (
		ctx
	): Promise<{ suggested: number; uncategorizedUnits: number; consideredUnits: number }> => {
		const input = await ctx.runQuery(internal.categories.getUncategorizedUnits, {});
		if (input.units.length === 0) {
			await ctx.runMutation(internal.categories.persistCategorySuggestions, {
				model: `${input.aiProvider}:${input.aiModel}`,
				suggestions: []
			});
			return { suggested: 0, uncategorizedUnits: 0, consideredUnits: 0 };
		}

		// Show the model the highest-weight uncategorized units first.
		const units = [...input.units].sort((a, b) => b.weight - a.weight).slice(0, MAX_SUGGEST_UNITS);
		const model = resolveModel(input.aiProvider, input.aiModel);
		const modelLabel = `${input.aiProvider}:${input.aiModel}`;

		const existing = input.categories
			.map((c) => `- ${c.slug}: ${c.name}${c.description ? ` — ${c.description}` : ''}`)
			.join('\n');
		const lines = units.map((unit, index) =>
			unit.kind === 'merchant'
				? `${index}. [merchant] "${unit.name}"${unit.plaidCategory ? ` (plaid: ${unit.plaidCategory})` : ''} — seen ${unit.weight}x`
				: `${index}. [amazon item] "${unit.title}" — bought ${unit.weight}x`
		);

		const schema = z.object({
			categories: z.array(
				z.object({ slug: z.string(), name: z.string(), description: z.string() })
			),
			assignments: z.array(z.object({ index: z.number(), slug: z.string() }))
		});

		const prompt =
			`A user tracks personal spending with these existing categories:\n\n${existing}\n\n` +
			`The purchases below could not be confidently placed in any of them. Propose up to ` +
			`${MAX_SUGGESTIONS} NEW categories (clearly distinct from the existing ones) that would ` +
			`group these purchases well. Use short lowercase-hyphenated slugs and a one-line ` +
			`description for each. Then assign every item to one of YOUR proposed slugs, or "none" ` +
			`if it truly fits none. Prefer fewer, broader categories over many tiny ones.\n\n` +
			`Items:\n\n${lines.join('\n')}`;

		const { object, usage } = await generateObject({ model, schema, prompt });

		console.log(
			`[suggest] ${units.length} uncategorized units -> ${object.categories.length} proposed. usage=${JSON.stringify(usage)}\n--- PROMPT ---\n${prompt}\n--- RESPONSE ---\n${JSON.stringify(object)}`
		);
		await ctx.runMutation(internal.categories.recordAiRun, {
			kind: 'suggestion',
			model: modelLabel,
			chunkIndex: 0,
			chunkCount: 1,
			unitCount: units.length,
			prompt,
			results: object,
			usage
		});

		// Keep proposals that don't collide with an existing slug, and group members under them.
		const existingSlugs = new Set(input.categories.map((c) => c.slug));
		const proposals = new Map<
			string,
			{
				slug: string;
				name: string;
				description: string;
				members: Array<{ kind: 'merchant' | 'asin'; key: string; title?: string; weight: number }>;
			}
		>();
		for (const category of object.categories) {
			if (!category.slug || existingSlugs.has(category.slug)) continue;
			if (proposals.has(category.slug)) continue;
			proposals.set(category.slug, {
				slug: category.slug,
				name: category.name,
				description: category.description ?? '',
				members: []
			});
		}

		for (const assignment of object.assignments) {
			const proposal = proposals.get(assignment.slug);
			const unit = units[assignment.index];
			if (!proposal || !unit) continue;
			proposal.members.push({
				kind: unit.kind,
				key: unit.key,
				title: unit.kind === 'merchant' ? unit.name : unit.title,
				weight: unit.weight
			});
		}

		const suggestions = [...proposals.values()].filter((proposal) => proposal.members.length > 0);
		await ctx.runMutation(internal.categories.persistCategorySuggestions, {
			model: modelLabel,
			suggestions
		});

		console.log(`[suggest] persisted ${suggestions.length} suggestion(s) with members.`);
		return {
			suggested: suggestions.length,
			uncategorizedUnits: input.units.length,
			consideredUnits: units.length
		};
	}
});
