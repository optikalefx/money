/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters_amazon from "../adapters/amazon.js";
import type * as adapters_index from "../adapters/index.js";
import type * as adapters_types from "../adapters/types.js";
import type * as aiActions from "../aiActions.js";
import type * as aiModels from "../aiModels.js";
import type * as categories from "../categories.js";
import type * as gmail from "../gmail.js";
import type * as gmailActions from "../gmailActions.js";
import type * as http from "../http.js";
import type * as plaid from "../plaid.js";
import type * as plaidActions from "../plaidActions.js";
import type * as reset from "../reset.js";
import type * as resolution from "../resolution.js";
import type * as transactions from "../transactions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/amazon": typeof adapters_amazon;
  "adapters/index": typeof adapters_index;
  "adapters/types": typeof adapters_types;
  aiActions: typeof aiActions;
  aiModels: typeof aiModels;
  categories: typeof categories;
  gmail: typeof gmail;
  gmailActions: typeof gmailActions;
  http: typeof http;
  plaid: typeof plaid;
  plaidActions: typeof plaidActions;
  reset: typeof reset;
  resolution: typeof resolution;
  transactions: typeof transactions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
