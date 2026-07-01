# Personal Money Tracker Build Plan

Last updated: 2026-07-01

## Product Goal

Build a personal money tracking app that separates expected spending from unplanned dynamic expenses. The app should sync transactions from Plaid and Amazon purchase emails, let transactions be marked as known recurring or expected, use AI to reduce manual categorization work, and provide date-filterable dashboards for dynamic spending.

## Core Definitions

- Known recurring: A transaction or merchant pattern that is part of the recurring expense map, such as rent, subscriptions, utilities, insurance, or other predictable bills.
- Expected: A transaction or merchant/category pattern that is budgeted but not necessarily recurring, such as restaurants, grocery, gas, or planned household spending.
- Dynamic: Any transaction that is not mapped to known recurring or expected spending. These are the transactions the dashboard should highlight.
- Source transaction: The original record imported from Plaid or parsed from Gmail.
- Normalized transaction: The app-level transaction record used by the UI, dedupe logic, categorization, and reporting.

## Phase 1: Foundation

- [x] Confirm app runtime architecture: SvelteKit frontend, Convex backend, Vercel deployment, Convex scheduled functions for sync jobs.
- [x] Confirm auth strategy for a single-user personal app.
- [ ] Add Convex auth configuration if user authentication is required.
- [x] Define environment variables in Convex config for Plaid, Gmail, Google OAuth, OpenAI or chosen AI provider, and sync controls.
- [ ] Decide whether Plaid and Gmail OAuth setup flows live in SvelteKit routes, Convex HTTP actions, or a split between both.
- [ ] Add a minimal settings area for connection status, reconnect actions, and manual sync triggers.
- [~] Document local setup steps in `README.md` once integrations are implemented. (Gmail/GCP + Plaid setup documented; Plaid setup steps are brief.)

## Phase 2: Data Model

- [x] Create Convex schema tables with indexed access patterns.
- [ ] Add `users` or `profiles` table if auth is enabled.
- [x] Add `connections` table for Plaid and Gmail connection metadata.
- [x] Add `plaidItems` table for Plaid item state, institution, account list, sync cursor, and reconnect status.
- [x] Add `accounts` table for bank and credit card accounts.
- [x] Add `transactions` table for normalized transactions.
- [x] Add `transactionSources` table for raw Plaid and Gmail source records, keyed by provider IDs for dedupe.
- [x] Add `merchantRules` table for recurring and expected merchant matching.
- [x] Add `categoryRules` table for expected category matching.
- [x] Add `aiClassifications` table for AI classification attempts, confidence, prompt version, and review state.
- [x] Add `amazonOrders` and `amazonOrderItems` tables for parsed Gmail/Amazon purchase detail.
- [x] Add `syncRuns` table for cron/manual run auditing, errors, counts, and durations.
- [x] Add indexes for date range views, dynamic expense filters, source dedupe, account filtering, merchant matching, and sync status.
- [x] Avoid unbounded arrays in Convex documents; store line items, source records, and sync runs as separate documents.

## Phase 3: Plaid Connection

- [x] Add Plaid SDK dependency and server-only Plaid client helper.
- [x] Implement create Link token endpoint/action.
- [x] Implement exchange public token flow and store encrypted or provider-safe access token reference.
- [x] Store Plaid item, institution, available accounts, and initial sync cursor.
- [x] Add UI flow to connect Chase or another Plaid-supported account.
- [x] Add connection status UI with institution name, account list, last sync, and sync health.
- [x] Validate Plaid Link connection with live production Chase data.
- [ ] Detect Plaid item errors that require user action.
- [ ] Implement update mode Link token flow for reconnect/repair.
- [ ] Add reconnect UI that launches Plaid Link update mode and clears the repair-needed state on success.

## Phase 4: Plaid Transaction Sync

- [x] Implement manual Plaid transaction sync for one item using Plaid Transactions Sync.
- [ ] Implement scheduled daily Plaid sync for all active items.
- [x] Persist Plaid cursor only after all added, modified, and removed records are applied successfully.
- [x] Upsert normalized transactions from Plaid added/modified records.
- [x] Handle Plaid removed records without deleting user annotations blindly.
- [x] Normalize amount signs consistently so spending is positive in app views.
- [x] Normalize merchant name, date, pending status, account, payment channel, and Plaid categories.
- [x] Add provider-level dedupe by Plaid transaction ID.
- [ ] Add app-level duplicate detection for cases where the same Amazon purchase appears in both Plaid and Gmail.
- [x] Record sync results and errors in `syncRuns`.
- [x] Validate manual Plaid sync with live production transaction data.

## Phase 5: Gmail And Amazon Import

- [ ] Create Google Cloud OAuth app and Gmail API scope plan using least privilege. (User action: Google Cloud Console — see setup steps below.)
- [x] Implement Gmail OAuth connect flow. (`getGmailAuthUrl` action + `/gmail/callback` HTTP action.)
- [x] Store Gmail connection metadata and refresh token securely. (`gmailAccounts` table, Convex server-side only.)
- [x] Add Gmail connection status and reconnect UI. (Home-page Gmail panel with connect/reconnect/sync.)
- [x] Define Gmail search query for the specific Amazon email address and relevant order/shipping/receipt subjects. (`DEFAULT_AMAZON_QUERY`, overridable via `GMAIL_AMAZON_QUERY`.)
- [x] Implement manual Gmail sync for Amazon messages. (`syncGmail` action.)
- [ ] Implement scheduled daily Gmail sync.
- [x] Store raw email metadata and parsed source payloads for auditability. (Snippet + headers stored on `amazonOrders.raw`.)
- [x] Parse Amazon order ID, order date, merchant, subtotal, tax, shipping, total, payment method hints, and item names when present. (Parser handles multi-order emails and the `Grand Total:`/`Total`/`Order Total:` variants; extracts order ID, date, net total, and item title/qty/price from the text/plain part — 99% total coverage on live data. Subtotal/tax/shipping aren't itemized in these emails, so they're left unset.)
- [x] Store Amazon order items separately from transactions. (`amazonOrderItems` table + idempotent replace on re-sync; populated by the parser.)
- [x] Link Amazon order records to matching Plaid transactions using date, amount, card/account hints, and merchant patterns. (Amount + date-window match against `amazon` merchants.)
- [x] Add a review state for unmatched Amazon orders or uncertain matches. (`amazonOrders.reviewState`: unmatched/matched/review.)

### Google Cloud OAuth setup (user action required)

- Create a Google Cloud project and enable the Gmail API.
- Configure the OAuth consent screen: External, Testing mode, add your own email as a test user.
- Create an OAuth **Web application** client.
- Least-privilege scope: `https://www.googleapis.com/auth/gmail.readonly`.
- Authorized redirect URI: `${PUBLIC_CONVEX_SITE_URL}/gmail/callback`.
- Set Convex env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (the callback URL above). Optionally `GMAIL_POST_AUTH_URL` (app URL to return to after consent) and `GMAIL_AMAZON_QUERY` (search override).

## Phase 6: Classification And Rules

- [ ] Define first-pass deterministic categorization rules before AI: merchant exact match, normalized merchant match, Plaid category, amount range, and recurring cadence.
- [ ] Add mutations to mark a transaction as `knownRecurring`, `expected`, or `dynamic`.
- [ ] When marking a transaction, offer to create or update a merchant rule for future matching.
- [ ] Add rule precedence: manual transaction override, merchant rule, category rule, AI classification, default dynamic.
- [ ] Add fields for classification source, confidence, and reviewed state.
- [ ] Add bulk actions for selected transactions.
- [ ] Add expected categories for food, grocery, gas, pharmacy, and other budgeted everyday spending.
- [ ] Add recurring detection suggestions based on merchant, amount similarity, and cadence.
- [ ] Add a review queue for low-confidence or newly detected recurring candidates.

## Phase 7: AI Daily Categorization

- [ ] Choose AI provider and model.
- [ ] Create a compact classification schema for the prompt output.
- [ ] Run AI only on transactions not already classified by manual overrides or deterministic rules.
- [ ] Batch daily uncategorized transactions into small prompts with merchant, amount, date, account type, Plaid category, and prior rule hints.
- [ ] Ask AI to classify into `knownRecurring`, `expected`, or `dynamic`, plus category and short reason.
- [ ] Validate AI output with strict JSON parsing and Convex validators.
- [ ] Store prompt version, model, input hash, output, confidence, and reason in `aiClassifications`.
- [ ] Apply high-confidence classifications automatically for expected everyday categories like restaurants and groceries.
- [ ] Route low-confidence classifications to the review queue.
- [ ] Add a daily scheduled function after Plaid/Gmail sync completes.
- [ ] Add budget controls so AI can be disabled or limited.

## Phase 8: Transaction UI

- [ ] Replace starter SvelteKit page with the money tracker app shell.
- [ ] Follow `docs/design-style-guide.md` and existing tokens in `src/app.css`.
- [ ] Add transaction list with date range, account, source, merchant, category, amount, classification, and review filters.
- [ ] Add search by merchant, item, category, or notes.
- [ ] Add row actions to mark as known recurring, expected, or dynamic.
- [ ] Add a transaction detail drawer/modal with source details, Plaid metadata, Amazon items, AI reason, and rule matches.
- [ ] Add rule creation/edit controls from a transaction.
- [ ] Add bulk classification controls.
- [ ] Add pending/synced/error visual states for data freshness.
- [ ] Add empty states for no connection, no transactions, and no dynamic expenses.

## Phase 9: Dynamic Expense Dashboard

- [ ] Add date-filterable dashboard defaulting to the current month.
- [ ] Show total dynamic spending for selected period.
- [ ] Show dynamic spending by category.
- [ ] Show top dynamic merchants.
- [ ] Show dynamic transaction table linked to detail view.
- [ ] Show trend chart by week/month.
- [ ] Show expected vs dynamic comparison.
- [ ] Show unreviewed classification count and link to review queue.
- [ ] Add category drill-down.
- [ ] Add export to CSV for filtered dynamic transactions.

## Phase 10: Budget And Known Expense Map

- [ ] Add recurring expense list grouped by merchant/category.
- [ ] Show expected monthly amount, observed amount, cadence, last seen date, and next expected date.
- [ ] Add expected category budget map for food, grocery, gas, and other non-recurring expected categories.
- [ ] Show variance between expected budget and observed spend.
- [ ] Allow rule pause, archive, edit, and delete.
- [ ] Add audit history for user changes to transaction classifications and rules.

## Phase 11: Security And Privacy

- [ ] Keep Plaid and Gmail tokens server-side only.
- [ ] Avoid exposing raw provider payloads to the client unless needed for the selected view.
- [ ] Add least-privilege Gmail scopes.
- [ ] Add secret rotation notes.
- [ ] Add data deletion controls for connections, imported source records, and normalized transactions.
- [ ] Add manual sync rate limits or guardrails.
- [ ] Redact sensitive values from logs and sync run errors.

## Phase 12: Testing And Verification

- [ ] Add unit tests for merchant normalization.
- [ ] Add unit tests for Plaid transaction normalization.
- [ ] Add unit tests for Gmail/Amazon parsing fixtures.
- [ ] Add tests for classification precedence.
- [ ] Add tests for duplicate detection between Plaid and Gmail/Amazon records.
- [ ] Add Convex function tests or focused integration checks for sync mutations.
- [ ] Add UI checks for transaction filtering and marking workflows.
- [ ] Run `npm run check`.
- [ ] Run `npm run lint`.
- [ ] Manually test Plaid connect, reconnect, manual sync, Gmail connect, Gmail sync, classification, and dashboard filters.

## Suggested Build Order

- [x] Milestone 1: Data model, transaction list, and manual marking. (Built against live Plaid data.)
- [x] Milestone 2: Rule engine and dynamic dashboard.
- [~] Milestone 3: Plaid connect and transaction sync done; reconnect/update-mode still pending.
- [x] Milestone 4: Gmail connect and Amazon order parsing (incl. ASIN extraction).
- [~] Milestone 5: Plaid/Amazon matching done; duplicate/double-count handling still pending.
- [ ] Milestone 6: AI daily categorization and review queue.
- [ ] Milestone 7: Budget map, recurring expense management, polish, tests, and deployment hardening.

## Current Status

- [x] Convex schema and generated types are in place.
- [x] Plaid production credentials are configured in Convex dev and production environments.
- [x] Plaid Link creates a token and connects successfully from the local Svelte app.
- [x] Plaid manual sync imports live Chase transaction data into Convex.
- [x] Recent transaction display is available for inspecting imported transaction shape.
- [x] Transaction marking UI is implemented (recurring/expected merchant rules, expected/transfer category rules, unmark).
- [x] Merchant and category rules auto-classify on sync (`classifyFromRules`).
- [x] First Dynamic expenses dashboard is live (dynamic total, by-category, top-merchants, review queue) plus a recurring page.
- [x] Gmail OAuth connect + manual Amazon sync + order/transaction matching implemented and working on live data.
- [x] Amazon email parser extracts order ID, net total, and per-item title/qty/price + ASIN (99% total coverage; 26/29 recent Amazon charges enriched with real item names).
- [x] Matched Amazon items enrich the Plaid transaction in the review queue (shows the item bought, not "Amazon"); long names truncate to 6 words with a hover tooltip (tippy.js).
- [x] Amazon item classification is keyed on ASIN: marking a row creates/updates an `amazonItemRules` entry and applies it to all transactions sharing that ASIN; new Gmail matches auto-apply the rule.
- [x] Recurring page groups Amazon recurring spend per item/ASIN with per-item Unmark, visually identical to merchant rows.
- [x] Plaid re-sync preserves existing classification/kind (no longer clobbers manual, category-rule, or ASIN-rule results).
- [ ] Reconnect/update mode for Plaid is not implemented yet.
- [ ] Scheduled Plaid and Gmail sync are not implemented yet.

## Next Phase

The Plaid + Gmail/Amazon workflow is usable end-to-end on live data (connect, sync, review,
classify by merchant/category/ASIN, recurring management). Remaining work, roughly in priority order:

- [ ] Automate syncing: scheduled daily Plaid + Gmail sync via Convex cron (currently manual "Sync now" / "Sync Amazon" buttons only).
- [ ] Plaid reconnect / update-mode flow for when an item breaks (Phase 3).
- [ ] App-level duplicate detection so a matched Amazon order doesn't double-count against its Plaid charge (44 matches > 29 charges today; same-priced orders can share a charge).
- [ ] Break Amazon order items into the dynamic dashboard math (per the confirmed decision that item detail should affect category totals).
- [ ] Dashboard depth (Phase 9/10): trend chart, expected-vs-dynamic comparison, CSV export, category drill-down, budget/recurring map with expected-vs-observed variance.
- [ ] AI daily categorization (Phase 7): `aiClassifications` table + OpenAI pass for still-`dynamic` transactions, low-confidence → review queue.
- [ ] Tests (Phase 12): merchant/Plaid normalization, Amazon parser fixtures, classification precedence, Plaid↔Amazon dedupe.

### Known limitations to revisit

- Multi-item Amazon orders attribute recurring totals to the primary (first) item's ASIN; single-item Subscribe & Save is exact.
- Amazon history predates Plaid's ~7-week transaction window, so older orders stay unmatched (data limitation, not a bug).
- `tippy.js` is v6 with some npm-audit advisories (transitive, not runtime-critical).

## Open Decisions

- [x] Choose auth provider, or confirm this remains a single-user app with a simpler access model.
- [x] Choose where OAuth callback routes should live. Gmail OAuth callback lives in a Convex HTTP action (`http.ts` → `/gmail/callback`), keeping refresh tokens server-side like the Plaid access token.
- [ ] Choose token storage approach and whether an additional encryption layer is required beyond provider/platform secret storage.
- [x] Choose AI provider/model and daily classification cost limit.
- [ ] Define exact food/grocery/expected categories for the initial budget map.
- [x] Decide whether Amazon order item details should affect category totals or only enrich transaction detail views.
- [ ] Decide initial dashboard chart library.
- [ ] Decide deployment cron ownership: Convex scheduler only, Vercel cron triggering Convex HTTP actions, or both.

## Notes For Implementation

- Read `src/convex/_generated/ai/guidelines.md` before editing Convex code.
- Use public Convex functions only for client-safe operations; keep sync, token, and provider logic internal or behind HTTP actions as appropriate.
- Add validators to every Convex function.
- Prefer indexed queries and pagination for transaction lists.
- Keep source records and normalized transactions separate so parsing and dedupe can evolve without losing raw audit data.
- Keep manual user classifications authoritative over rules and AI.
- Make dynamic expenses the primary dashboard lens, not a buried filter.

## Confirmed Decisions

- This is a strictly personal app protected by Vercel's built-in auth; no separate Convex user auth is planned for the initial build.
- Plaid should use production credentials and real data from Chase.
- Gmail import should connect to the normal Gmail account and filter Amazon messages.
- AI categorization will use OpenAI.
- Food, grocery, gas, and similar expected categories should be excluded from the Dynamic dashboard while remaining available for summaries and math.
- Amazon spending should be broken out into individual order items because the Chase transaction line is not useful enough by itself.
- The Amazon orders view does not live on the homepage; instead, matched Amazon items enrich the Plaid transaction in the review queue (the "Amazon" line shows the actual item bought) so it flows through the normal categorize/mark workflow.
- Amazon item classification rules are keyed on the product **ASIN** (parsed from the confirmation email's `/dp/<ASIN>` title link), not the item title, so repeat purchases (Subscribe & Save) auto-classify and title edits don't break the rule. ASINs are not present as plain fields — they're extracted from the URL-encoded `/gp/r.html` redirect links.
- On Plaid re-sync of an existing transaction, the classification and kind are preserved (a "modified" record must not wipe a manual mark, a category-rule transfer, or an ASIN-rule result).
- Build should start against real data so the schema and UI can adapt to actual Plaid and Gmail shapes.
