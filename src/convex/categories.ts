import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx
} from './_generated/server';

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

// ---------------------------------------------------------------------------
// AI categorization support (called from the `'use node'` action in aiActions.ts)
// ---------------------------------------------------------------------------

const SCAN_LIMIT = 500;

// Gather everything the AI needs in one round trip: the taxonomy, the chosen model, and the
// distinct uncategorized "units" (non-Amazon merchants + Amazon ASINs) still needing a category.
export const getCategorizationInput = internalQuery({
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

		// Non-Amazon merchant units from dynamic + unreviewed expense transactions.
		const dynamicRows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) => q.eq('classification', 'dynamic'))
			.order('desc')
			.take(SCAN_LIMIT);
		const unreviewedRows = await ctx.db
			.query('transactions')
			.withIndex('by_classification_and_date', (q) => q.eq('classification', 'unreviewed'))
			.order('desc')
			.take(SCAN_LIMIT);

		const merchantUnits = new Map<
			string,
			{ normalizedMerchant: string; name: string; plaidCategory: string }
		>();
		for (const row of [...dynamicRows, ...unreviewedRows]) {
			if (row.removed || row.kind !== 'expense') continue;
			if (row.categorySlug) continue;
			if (row.normalizedMerchant.includes('amazon')) continue;
			if (merchantUnits.has(row.normalizedMerchant)) continue;
			const cached = await ctx.db
				.query('merchantCategories')
				.withIndex('by_normalizedMerchant', (q) =>
					q.eq('normalizedMerchant', row.normalizedMerchant)
				)
				.take(1);
			if (cached[0]) continue;
			merchantUnits.set(row.normalizedMerchant, {
				normalizedMerchant: row.normalizedMerchant,
				name: row.merchantName ?? row.name,
				plaidCategory: row.categoryDetailed ?? row.categoryPrimary ?? ''
			});
		}

		// Amazon ASIN units from parsed order items without a cached category.
		const items = await ctx.db.query('amazonOrderItems').order('desc').take(SCAN_LIMIT);
		const asinUnits = new Map<string, { asin: string; title: string }>();
		for (const item of items) {
			if (!item.asin || asinUnits.has(item.asin)) continue;
			const cached = await ctx.db
				.query('amazonItemCategories')
				.withIndex('by_asin', (q) => q.eq('asin', item.asin!))
				.take(1);
			if (cached[0]) continue;
			asinUnits.set(item.asin, { asin: item.asin, title: item.title });
		}

		return {
			categories,
			aiProvider: config?.aiProvider ?? DEFAULT_AI_CONFIG.aiProvider,
			aiModel: config?.aiModel ?? DEFAULT_AI_CONFIG.aiModel,
			merchantUnits: [...merchantUnits.values()],
			asinUnits: [...asinUnits.values()]
		};
	}
});

export const saveCategoryAssignments = internalMutation({
	args: {
		model: v.optional(v.string()),
		merchants: v.array(v.object({ normalizedMerchant: v.string(), categorySlug: v.string() })),
		asins: v.array(
			v.object({ asin: v.string(), title: v.optional(v.string()), categorySlug: v.string() })
		)
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		let applied = 0;

		for (const merchant of args.merchants) {
			const existing = await ctx.db
				.query('merchantCategories')
				.withIndex('by_normalizedMerchant', (q) =>
					q.eq('normalizedMerchant', merchant.normalizedMerchant)
				)
				.unique();
			const doc = {
				normalizedMerchant: merchant.normalizedMerchant,
				categorySlug: merchant.categorySlug,
				source: 'ai' as const,
				model: args.model,
				active: true,
				updatedAt: now
			};
			if (existing) {
				await ctx.db.patch(existing._id, doc);
			} else {
				await ctx.db.insert('merchantCategories', { ...doc, createdAt: now });
			}

			const transactions = await ctx.db
				.query('transactions')
				.withIndex('by_normalizedMerchant', (q) =>
					q.eq('normalizedMerchant', merchant.normalizedMerchant)
				)
				.take(500);
			for (const transaction of transactions) {
				if (transaction.removed) continue;
				if (transaction.categorySource === 'manual') continue;
				await ctx.db.patch(transaction._id, {
					categorySlug: merchant.categorySlug,
					categorySource: 'ai',
					updatedAt: now
				});
				applied += 1;
			}
		}

		for (const asin of args.asins) {
			const existing = await ctx.db
				.query('amazonItemCategories')
				.withIndex('by_asin', (q) => q.eq('asin', asin.asin))
				.unique();
			const doc = {
				asin: asin.asin,
				title: asin.title,
				categorySlug: asin.categorySlug,
				source: 'ai' as const,
				model: args.model,
				active: true,
				updatedAt: now
			};
			if (existing) {
				await ctx.db.patch(existing._id, doc);
			} else {
				await ctx.db.insert('amazonItemCategories', { ...doc, createdAt: now });
			}

			const items = await ctx.db
				.query('amazonOrderItems')
				.withIndex('by_asin', (q) => q.eq('asin', asin.asin))
				.take(500);
			for (const item of items) {
				if (item.categorySource === 'manual') continue;
				await ctx.db.patch(item._id, {
					category: asin.categorySlug,
					categorySource: 'ai',
					updatedAt: now
				});
				applied += 1;
			}
		}

		return { applied };
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
