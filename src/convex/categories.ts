import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx
} from './_generated/server';
import { loadResolutionData, ruleStatusFor } from './resolution';

const aiProvider = v.union(v.literal('openai'), v.literal('anthropic'));

// Canonical starter taxonomy. `description` tells the AI how to route a transaction into the
// category; it can be blank when the name is self-evident.
const DEFAULT_CATEGORIES: Array<{ slug: string; name: string; description: string }> = [
	{
		slug: 'groceries',
		name: 'Groceries',
		description:
			'Supermarket and grocery-store food and household staples bought to stock the home.'
	},
	{
		slug: 'dining',
		name: 'Dining & Restaurants',
		description: 'Restaurants, cafes, coffee shops, bars, fast food, and food delivery.'
	},
	{
		slug: 'household',
		name: 'Household & Supplies',
		description:
			'Everyday consumable household supplies: cleaning, paper goods, toiletries, kitchen basics.'
	},
	{
		slug: 'health',
		name: 'Health & Personal Care',
		description: 'Pharmacy, medicine, vitamins, supplements, personal care, and grooming.'
	},
	{
		slug: 'electronics',
		name: 'Electronics & Tech',
		description: 'Gadgets, computers, phones, accessories, cables, and consumer electronics.'
	},
	{
		slug: 'kids',
		name: 'Kids & Baby',
		description: "Children's and baby items: toys, diapers, clothing, gear, and supplies."
	},
	{
		slug: 'clothing',
		name: 'Clothing & Apparel',
		description: 'Clothing, shoes, and accessories for adults.'
	},
	{
		slug: 'home',
		name: 'Home & Garden',
		description: 'Furniture, decor, tools, appliances, and garden or outdoor items.'
	},
	{
		slug: 'entertainment',
		name: 'Entertainment & Media',
		description: 'Books, games, movies, music, hobbies, streaming, and leisure.'
	},
	{ slug: 'pets', name: 'Pets', description: 'Pet food, supplies, and care.' },
	{ slug: 'gifts', name: 'Gifts', description: 'Gifts and items bought for other people.' },
	{
		slug: 'uncategorized',
		name: 'Uncategorized',
		description: "Fallback when a transaction doesn't clearly fit any other category."
	}
];

const DEFAULT_AI_CONFIG = { aiProvider: 'openai' as const, aiModel: 'gpt-4o-mini' };

export const listCategories = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('categories')
			.withIndex('by_active', (q) => q.eq('active', true))
			.take(200);
		return rows
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((row) => ({
				id: row._id,
				slug: row.slug,
				name: row.name,
				description: row.description ?? '',
				treatment: row.treatment ?? null,
				isDefault: row.isDefault,
				sortOrder: row.sortOrder
			}));
	}
});

// Idempotent: seed the starter taxonomy only when the table is empty. Called from the
// categories page on mount (queries can't write, so seeding lives in a mutation).
export const ensureDefaultCategories = mutation({
	args: {},
	handler: async (ctx) => {
		const existing = await ctx.db.query('categories').take(1);
		if (existing.length > 0) return { seeded: 0 };

		const now = Date.now();
		let sortOrder = 0;
		for (const category of DEFAULT_CATEGORIES) {
			await ctx.db.insert('categories', {
				slug: category.slug,
				name: category.name,
				description: category.description,
				sortOrder: sortOrder++,
				active: true,
				isDefault: true,
				createdAt: now,
				updatedAt: now
			});
		}
		return { seeded: DEFAULT_CATEGORIES.length };
	}
});

export const upsertCategory = mutation({
	args: {
		id: v.optional(v.id('categories')),
		name: v.string(),
		description: v.optional(v.string()),
		sortOrder: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const name = args.name.trim();
		if (!name) throw new Error('Category name is required.');
		const description = args.description?.trim() || undefined;

		if (args.id) {
			await ctx.db.patch(args.id, {
				name,
				description,
				...(args.sortOrder !== undefined ? { sortOrder: args.sortOrder } : {}),
				updatedAt: now
			});
			return { id: args.id };
		}

		const slug = await uniqueSlug(ctx, name);
		const highest = await ctx.db.query('categories').take(200);
		const nextOrder =
			args.sortOrder ?? highest.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
		const id = await ctx.db.insert('categories', {
			slug,
			name,
			description,
			sortOrder: nextOrder,
			active: true,
			isDefault: false,
			createdAt: now,
			updatedAt: now
		});
		return { id, slug };
	}
});

export const deleteCategory = mutation({
	args: { id: v.id('categories') },
	handler: async (ctx, args) => {
		const category = await ctx.db.get(args.id);
		if (!category) return { ok: true };
		if (category.slug === 'uncategorized') {
			throw new Error('The Uncategorized fallback cannot be deleted.');
		}
		await ctx.db.delete(args.id);
		return { ok: true };
	}
});

export const getAiConfig = query({
	args: {},
	handler: async (ctx) => {
		const config = (await ctx.db.query('appConfig').take(1))[0];
		return {
			aiProvider: config?.aiProvider ?? DEFAULT_AI_CONFIG.aiProvider,
			aiModel: config?.aiModel ?? DEFAULT_AI_CONFIG.aiModel
		};
	}
});

export const setAiConfig = mutation({
	args: { aiProvider, aiModel: v.string() },
	handler: async (ctx, args) => {
		const now = Date.now();
		const model = args.aiModel.trim();
		if (!model) throw new Error('A model id is required.');
		const existing = (await ctx.db.query('appConfig').take(1))[0];
		if (existing) {
			await ctx.db.patch(existing._id, {
				aiProvider: args.aiProvider,
				aiModel: model,
				updatedAt: now
			});
			return { id: existing._id };
		}
		const id = await ctx.db.insert('appConfig', {
			aiProvider: args.aiProvider,
			aiModel: model,
			updatedAt: now
		});
		return { id };
	}
});

// Seed the singleton `appConfig` row with the defaults if it doesn't exist yet. Idempotent, so it's
// safe to run on every deploy. Run once with `npx convex run categories:initAppConfig`.
export const initAppConfig = internalMutation({
	args: {},
	handler: async (ctx) => {
		const existing = (await ctx.db.query('appConfig').take(1))[0];
		if (existing) return { id: existing._id, created: false };
		const id = await ctx.db.insert('appConfig', {
			aiProvider: DEFAULT_AI_CONFIG.aiProvider,
			aiModel: DEFAULT_AI_CONFIG.aiModel,
			updatedAt: Date.now()
		});
		return { id, created: true };
	}
});

// ---------------------------------------------------------------------------
// AI categorization support (called from the `'use node'` action in aiActions.ts)
// ---------------------------------------------------------------------------

// Persist one AI request/response for later inspection.
export const recordAiRun = internalMutation({
	args: {
		kind: v.string(),
		model: v.string(),
		chunkIndex: v.number(),
		chunkCount: v.number(),
		unitCount: v.number(),
		prompt: v.string(),
		results: v.any(),
		usage: v.optional(v.any())
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('aiRuns', { ...args, createdAt: Date.now() });
	}
});

// Most recent AI runs (prompt + response + usage) for the categories page / debugging.
export const listAiRuns = query({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('aiRuns')
			.withIndex('by_createdAt')
			.order('desc')
			.take(Math.min(args.limit ?? 20, 100));
		return rows.map((row) => ({
			id: row._id,
			kind: row.kind,
			model: row.model,
			chunkIndex: row.chunkIndex,
			chunkCount: row.chunkCount,
			unitCount: row.unitCount,
			prompt: row.prompt,
			results: row.results,
			usage: row.usage ?? null,
			createdAt: row.createdAt
		}));
	}
});

const SCAN_LIMIT = 500;

// A cache row is "settled" when it holds a real category, or is a manual pick (even if
// uncategorized). An AI-assigned `uncategorized` is a miss, so Categorize retries it every run.
function isSettledCategory(
	cached: { categorySlug: string; source: 'ai' | 'manual' } | undefined
): boolean {
	if (!cached) return false;
	return cached.categorySlug !== 'uncategorized' || cached.source === 'manual';
}

// Gather everything the AI needs in one round trip: the taxonomy, the chosen model, and the
// distinct uncategorized "units" (non-Amazon merchants + item SKUs) still needing a category.
export const getCategorizationInput = internalQuery({
	args: { force: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		// `force` re-sends every distinct dynamic merchant/ASIN even if already cached — useful
		// after editing the taxonomy, and so the prompt/response are re-captured for inspection.
		const force = args.force ?? false;

		const categories = (
			await ctx.db
				.query('categories')
				.withIndex('by_active', (q) => q.eq('active', true))
				.take(200)
		)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((row) => ({ slug: row.slug, name: row.name, description: row.description ?? '' }));

		const config = (await ctx.db.query('appConfig').take(1))[0];

		// Merchant units: distinct non-Amazon merchants from recent expense charges still needing
		// the AI. A merchant is settled only if it has a real cached category or a manual pick — an
		// AI-assigned `uncategorized` is a miss and gets retried every run (that's what Categorize is
		// for). `force` re-sends everything.
		const txns = await ctx.db.query('transactions').withIndex('by_date').order('desc').take(SCAN_LIMIT);
		const merchantUnits = new Map<
			string,
			{ normalizedMerchant: string; name: string; plaidCategory: string }
		>();
		for (const row of txns) {
			if (row.removed || row.kind !== 'expense') continue;
			if (row.normalizedMerchant.includes('amazon')) continue;
			if (merchantUnits.has(row.normalizedMerchant)) continue;
			if (!force) {
				const cached = (
					await ctx.db
						.query('merchantCategories')
						.withIndex('by_normalizedMerchant', (q) =>
							q.eq('normalizedMerchant', row.normalizedMerchant)
						)
						.take(1)
				)[0];
				if (isSettledCategory(cached)) continue;
			}
			merchantUnits.set(row.normalizedMerchant, {
				normalizedMerchant: row.normalizedMerchant,
				name: row.merchantName ?? row.name,
				plaidCategory: row.categoryDetailed ?? row.categoryPrimary ?? ''
			});
		}

		// Item units: distinct `(merchant, sku)` from recent orders still needing the AI (same
		// "settled" rule as merchants).
		const orders = await ctx.db.query('orders').order('desc').take(SCAN_LIMIT);
		const itemUnits = new Map<string, { merchant: string; sku: string; title: string }>();
		for (const order of orders) {
			const orderItems = await ctx.db
				.query('orderItems')
				.withIndex('by_orderId', (q) => q.eq('orderId', order._id))
				.take(50);
			for (const item of orderItems) {
				if (!item.sku) continue;
				const key = `${order.merchant} ${item.sku}`;
				if (itemUnits.has(key)) continue;
				if (!force) {
					const cached = (
						await ctx.db
							.query('itemCategories')
							.withIndex('by_merchant_sku', (q) =>
								q.eq('merchant', order.merchant).eq('sku', item.sku!)
							)
							.take(1)
					)[0];
					if (isSettledCategory(cached)) continue;
				}
				itemUnits.set(key, { merchant: order.merchant, sku: item.sku, title: item.title });
			}
		}

		return {
			categories,
			aiProvider: config?.aiProvider ?? DEFAULT_AI_CONFIG.aiProvider,
			aiModel: config?.aiModel ?? DEFAULT_AI_CONFIG.aiModel,
			merchantUnits: [...merchantUnits.values()],
			itemUnits: [...itemUnits.values()]
		};
	}
});

export const saveCategoryAssignments = internalMutation({
	args: {
		model: v.optional(v.string()),
		merchants: v.array(v.object({ normalizedMerchant: v.string(), categorySlug: v.string() })),
		items: v.array(
			v.object({
				merchant: v.string(),
				sku: v.string(),
				title: v.optional(v.string()),
				categorySlug: v.string()
			})
		)
	},
	handler: async (ctx, args) => {
		let applied = 0;
		for (const merchant of args.merchants) {
			applied += await applyMerchantCategory(ctx, merchant.normalizedMerchant, merchant.categorySlug, {
				model: args.model
			});
		}
		for (const item of args.items) {
			applied += await applyItemCategory(ctx, item.merchant, item.sku, item.categorySlug, {
				model: args.model,
				title: item.title
			});
		}
		return { applied };
	}
});

// Set (or clear with `null`) a canonical category's `treatment`. Every line in the category
// resolves to that treatment at read time, so there is nothing to fan out.
export const setCategoryTreatment = mutation({
	args: {
		id: v.id('categories'),
		treatment: v.union(v.literal('expected'), v.literal('transfer'), v.null())
	},
	handler: async (ctx, args) => {
		const category = await ctx.db.get(args.id);
		if (!category) throw new Error('Category not found.');
		await ctx.db.patch(args.id, {
			treatment: args.treatment ?? undefined,
			updatedAt: Date.now()
		});
		return { ok: true, slug: category.slug, treatment: args.treatment };
	}
});

type ApplyOpts = { model?: string; source?: 'ai' | 'manual'; title?: string };

// Upsert the per-merchant category assignment. Category is resolved from this cache at read time,
// so there is no per-transaction fan-out. A manual pick outranks (and is never overwritten by) AI.
export async function applyMerchantCategory(
	ctx: MutationCtx,
	normalizedMerchant: string,
	categorySlug: string,
	opts: ApplyOpts = {}
) {
	const now = Date.now();
	const source = opts.source ?? 'ai';
	const existing = await ctx.db
		.query('merchantCategories')
		.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', normalizedMerchant))
		.unique();
	if (existing && existing.source === 'manual' && source === 'ai') return 0;
	const doc = { normalizedMerchant, categorySlug, source, model: opts.model, active: true, updatedAt: now };
	if (existing) {
		await ctx.db.patch(existing._id, doc);
	} else {
		await ctx.db.insert('merchantCategories', { ...doc, createdAt: now });
	}
	return 1;
}

// Upsert the per-product `(merchant, sku)` category assignment. Resolved at read time, so no
// fan-out. A manual pick outranks (and is never overwritten by) AI.
export async function applyItemCategory(
	ctx: MutationCtx,
	merchant: string,
	sku: string,
	categorySlug: string,
	opts: ApplyOpts = {}
) {
	const now = Date.now();
	const source = opts.source ?? 'ai';
	const existing = await ctx.db
		.query('itemCategories')
		.withIndex('by_merchant_sku', (q) => q.eq('merchant', merchant).eq('sku', sku))
		.unique();
	if (existing && existing.source === 'manual' && source === 'ai') return 0;
	const doc = {
		merchant,
		sku,
		title: opts.title ?? existing?.title,
		categorySlug,
		source,
		model: opts.model,
		active: true,
		updatedAt: now
	};
	if (existing) {
		await ctx.db.patch(existing._id, doc);
	} else {
		await ctx.db.insert('itemCategories', { ...doc, createdAt: now });
	}
	return 1;
}

// ---------------------------------------------------------------------------
// Category suggestions: mine the `uncategorized` bucket for missing categories.
// ---------------------------------------------------------------------------

const UNCATEGORIZED = 'uncategorized';

// Distinct merchants/ASINs currently sitting in Uncategorized, with an approximate weight
// (how many transactions/items each represents) so suggestions can show projected coverage.
export const getUncategorizedUnits = internalQuery({
	args: {},
	handler: async (ctx) => {
		const categories = (
			await ctx.db
				.query('categories')
				.withIndex('by_active', (q) => q.eq('active', true))
				.take(200)
		)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((row) => ({ slug: row.slug, name: row.name, description: row.description ?? '' }));

		const config = (await ctx.db.query('appConfig').take(1))[0];

		const merchantRows = (await ctx.db.query('merchantCategories').take(2000)).filter(
			(row) => row.active && row.categorySlug === UNCATEGORIZED
		);
		const merchantUnits: Array<{
			kind: 'merchant';
			key: string;
			name: string;
			plaidCategory: string;
			weight: number;
		}> = [];
		for (const row of merchantRows) {
			const txns = await ctx.db
				.query('transactions')
				.withIndex('by_normalizedMerchant', (q) =>
					q.eq('normalizedMerchant', row.normalizedMerchant)
				)
				.take(300);
			const active = txns.filter((t) => !t.removed);
			const sample = active[0];
			merchantUnits.push({
				kind: 'merchant',
				key: row.normalizedMerchant,
				name: sample?.merchantName ?? sample?.name ?? row.normalizedMerchant,
				plaidCategory: sample?.categoryDetailed ?? sample?.categoryPrimary ?? '',
				weight: Math.max(active.length, 1)
			});
		}

		const itemRows = (await ctx.db.query('itemCategories').take(2000)).filter(
			(row) => row.active && row.categorySlug === UNCATEGORIZED
		);
		const itemUnits: Array<{
			kind: 'item';
			key: string;
			merchant: string;
			title: string;
			weight: number;
		}> = [];
		for (const row of itemRows) {
			const items = await ctx.db
				.query('orderItems')
				.withIndex('by_sku', (q) => q.eq('sku', row.sku))
				.take(100);
			itemUnits.push({
				kind: 'item',
				key: row.sku,
				merchant: row.merchant,
				title: row.title ?? items[0]?.title ?? row.sku,
				weight: Math.max(items.length, 1)
			});
		}

		return {
			categories,
			aiProvider: config?.aiProvider ?? DEFAULT_AI_CONFIG.aiProvider,
			aiModel: config?.aiModel ?? DEFAULT_AI_CONFIG.aiModel,
			units: [...merchantUnits, ...itemUnits]
		};
	}
});

const suggestionMemberValidator = v.object({
	kind: v.union(v.literal('merchant'), v.literal('item')),
	key: v.string(),
	merchant: v.optional(v.string()),
	title: v.optional(v.string()),
	weight: v.number()
});

// Replace any prior pending suggestions with a fresh batch.
export const persistCategorySuggestions = internalMutation({
	args: {
		model: v.optional(v.string()),
		suggestions: v.array(
			v.object({
				slug: v.string(),
				name: v.string(),
				description: v.string(),
				members: v.array(suggestionMemberValidator)
			})
		)
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const stale = await ctx.db
			.query('categorySuggestions')
			.withIndex('by_status', (q) => q.eq('status', 'pending'))
			.take(200);
		for (const row of stale) await ctx.db.delete(row._id);

		for (const suggestion of args.suggestions) {
			const weight = suggestion.members.reduce((sum, member) => sum + member.weight, 0);
			await ctx.db.insert('categorySuggestions', {
				slug: suggestion.slug,
				name: suggestion.name,
				description: suggestion.description,
				memberCount: suggestion.members.length,
				weight,
				members: suggestion.members,
				status: 'pending',
				model: args.model,
				createdAt: now,
				updatedAt: now
			});
		}
		return { count: args.suggestions.length };
	}
});

export const listCategorySuggestions = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('categorySuggestions')
			.withIndex('by_status', (q) => q.eq('status', 'pending'))
			.take(50);
		return rows
			.sort((a, b) => b.weight - a.weight)
			.map((row) => ({
				id: row._id,
				name: row.name,
				description: row.description,
				memberCount: row.memberCount,
				weight: row.weight,
				sampleTitles: row.members.slice(0, 4).map((member) => member.title ?? member.key)
			}));
	}
});

// The actual transactions/items behind a suggestion's member units, for the expand view.
export const getSuggestionTransactions = query({
	args: { id: v.id('categorySuggestions') },
	handler: async (ctx, args) => {
		const suggestion = await ctx.db.get(args.id);
		if (!suggestion) return [];

		const data = await loadResolutionData(ctx);
		const rows: Array<{
			date: string;
			name: string;
			merchant: string;
			amount: number | null;
			source: string;
			// Whether this line is already pulled out of dynamic by a rule/treatment.
			status: 'recurring' | 'expected' | 'transfer' | null;
		}> = [];

		for (const member of suggestion.members) {
			if (member.kind === 'merchant') {
				const txns = await ctx.db
					.query('transactions')
					.withIndex('by_normalizedMerchant', (q) => q.eq('normalizedMerchant', member.key))
					.take(100);
				for (const t of txns) {
					if (t.removed) continue;
					rows.push({
						date: t.date,
						name: t.name,
						merchant: t.merchantName ?? t.name,
						amount: t.amount,
						source: 'plaid',
						status: ruleStatusFor(
							{ merchant: t.normalizedMerchant, sku: null },
							t.normalizedMerchant,
							data
						)
					});
				}
			} else {
				const items = await ctx.db
					.query('orderItems')
					.withIndex('by_sku', (q) => q.eq('sku', member.key))
					.take(50);
				for (const item of items) {
					const order = await ctx.db.get(item.orderId);
					const matched = order?.matchedTransactionId
						? await ctx.db.get(order.matchedTransactionId)
						: null;
					const merchant = order?.merchant ?? member.merchant ?? 'item';
					rows.push({
						date: order?.orderDate ?? '',
						name: item.title,
						merchant,
						amount: item.amount ?? null,
						source: order?.source ?? 'order',
						status: ruleStatusFor(
							{ merchant, sku: item.sku ?? null },
							matched?.normalizedMerchant ?? '',
							data
						)
					});
				}
			}
		}

		return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
	}
});

export const acceptCategorySuggestion = mutation({
	args: { id: v.id('categorySuggestions') },
	handler: async (ctx, args) => {
		const suggestion = await ctx.db.get(args.id);
		if (!suggestion || suggestion.status !== 'pending') {
			throw new Error('Suggestion is no longer available.');
		}
		const now = Date.now();

		// Create the category (unique slug), placed after existing ones.
		const slug = await uniqueSlug(ctx, suggestion.name);
		const all = await ctx.db.query('categories').take(200);
		const nextOrder = all.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
		await ctx.db.insert('categories', {
			slug,
			name: suggestion.name,
			description: suggestion.description,
			sortOrder: nextOrder,
			active: true,
			isDefault: false,
			createdAt: now,
			updatedAt: now
		});

		// Move its member units out of Uncategorized into the new category.
		let applied = 0;
		for (const member of suggestion.members) {
			if (member.kind === 'merchant') {
				applied += await applyMerchantCategory(ctx, member.key, slug, { model: suggestion.model });
			} else if (member.merchant) {
				applied += await applyItemCategory(ctx, member.merchant, member.key, slug, {
					model: suggestion.model,
					title: member.title
				});
			}
		}

		await ctx.db.patch(args.id, { status: 'accepted', updatedAt: now });
		return { slug, applied };
	}
});

export const dismissCategorySuggestion = mutation({
	args: { id: v.id('categorySuggestions') },
	handler: async (ctx, args) => {
		const suggestion = await ctx.db.get(args.id);
		if (suggestion && suggestion.status === 'pending') {
			await ctx.db.patch(args.id, { status: 'dismissed', updatedAt: Date.now() });
		}
		return { ok: true };
	}
});

async function uniqueSlug(ctx: MutationCtx, name: string) {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'category';
	let slug = base;
	let suffix = 1;
	while (
		(await ctx.db
			.query('categories')
			.withIndex('by_slug', (q) => q.eq('slug', slug))
			.take(1)
			.then((rows) => rows[0])) !== undefined
	) {
		slug = `${base}-${++suffix}`;
	}
	return slug;
}
