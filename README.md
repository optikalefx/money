# Personal Money Tracker

A personal money tracker that separates expected spending from dynamic (unplanned) expenses. It
syncs bank transactions from Plaid and Amazon order details from Gmail, classifies them with
merchant/category rules, and surfaces dynamic spending on a date-filterable dashboard.

Built with SvelteKit + Convex, deployed on Vercel.

## Running it yourself

Follow these steps in order. Steps 1–3 get the app running locally; steps 4–6 wire up the
integrations (all optional — the app runs without them, you just won't have any data to classify).

### 1. Prerequisites

- **Node.js 20+** and **npm**.
- A free **[Convex](https://convex.dev)** account (backend + database).
- A free **[Plaid](https://plaid.com)** account for bank sync.
- A free **Google Cloud** account for the Gmail/Amazon integration (optional).
- An **[OpenAI](https://platform.openai.com)** API key for AI transaction classification (optional). (Or Anthropic)

### 2. Clone and install

```sh
git clone git@github.com:optikalefx/money.git
cd money
npm install
```

### 3. Set up Convex

Convex is the backend/database. The dev command creates (or links) a deployment, pushes the
functions in `src/convex/`, and writes the connection URLs into `.env.local` for you.

```sh
npx convex dev
```

On first run it will prompt you to log in and create a project. Leave it running in its own
terminal — it hot-reloads backend functions and keeps the local `.env.local` in sync. It populates:

- `CONVEX_DEPLOYMENT` — the deployment `npx convex dev` targets.
- `PUBLIC_CONVEX_URL` — the `.convex.cloud` URL the SvelteKit client connects to.
- `PUBLIC_CONVEX_SITE_URL` — the `.convex.site` URL used for HTTP actions (the Gmail OAuth callback).

In a second terminal, start the SvelteKit dev server:

```sh
npm run dev
# or open a browser tab automatically:
npm run dev -- --open
```

The app is now running at http://localhost:5173. The integration credentials below are all stored
**server-side in Convex only** (set with `npx convex env set`), never in the frontend or in git.

## Integrations

This app syncs bank transactions from Plaid and Amazon order details from Gmail, and can classify
transactions with OpenAI. Each is optional and configured independently.

### 4. Plaid (bank transactions)

Plaid links your bank accounts and imports transactions. The client talks to Plaid entirely through
Convex actions, so all Plaid credentials live in Convex env vars.

1. **Create a Plaid account** and grab your keys from the [Plaid Dashboard](https://dashboard.plaid.com)
   under **Developers → Keys** (`client_id` and the secret for the environment you're using).
2. **Choose an environment.** `PLAID_ENV` accepts `sandbox`, `development`, or `production`, and
   defaults to `sandbox`. Sandbox uses Plaid's test credentials (e.g. `user_good` / `pass_good`) and
   needs no real bank — start there.
3. **Set the Convex environment variables:**

   ```sh
   npx convex env set PLAID_CLIENT_ID <client-id>
   npx convex env set PLAID_SECRET <secret>
   npx convex env set PLAID_ENV sandbox
   # Optional: only needed if you configure an OAuth redirect URI in the Plaid Dashboard
   npx convex env set PLAID_REDIRECT_URI http://localhost:5173
   ```

   Repeat with `--prod` to configure your production Convex deployment.

4. In the app, click **Connect Plaid** to launch Plaid Link and connect an institution, then
   **Sync now** to import transactions.

### 5. Gmail + Amazon (Google Cloud)

The Gmail integration uses a server-side OAuth authorization-code flow. The callback is a Convex
HTTP action at `${PUBLIC_CONVEX_SITE_URL}/gmail/callback` (note the `.convex.site` domain, not
`.convex.cloud`), which keeps the refresh token in Convex.

1. **Create a Google Cloud project** at https://console.cloud.google.com.
2. **Enable the Gmail API**: https://console.cloud.google.com/apis/library/gmail.googleapis.com →
   **Enable**. (Takes ~1–2 minutes to propagate.)
3. **Configure the OAuth consent screen**: User type **External**, publishing status **Testing**,
   and add your own Google account under **Test users**. (Testing mode is fine for a personal app;
   you'll see an "unverified app" screen at consent — click **Advanced → Go to (app) unsafe**.)
4. **Create credentials → OAuth client ID**, application type **Web application**:
   - **Authorized JavaScript origins**: leave blank (the flow is a full-page redirect, not an
     in-browser Google JS call).
   - **Authorized redirect URIs**: add your Convex site callback for each deployment you use, e.g.
     - Dev: `https://<dev-deployment>.convex.site/gmail/callback`
     - Prod: `https://<prod-deployment>.convex.site/gmail/callback`
5. **Restrict the scope** to read-only: `https://www.googleapis.com/auth/gmail.readonly`.
6. **Set the Convex environment variables** (client ID/secret are shared across deployments; the
   redirect URI must match that deployment's own `.convex.site` domain):

   ```sh
   # Dev deployment
   npx convex env set GOOGLE_CLIENT_ID <client-id>
   npx convex env set GOOGLE_CLIENT_SECRET <client-secret>
   npx convex env set GOOGLE_REDIRECT_URI https://<dev-deployment>.convex.site/gmail/callback

   # Production deployment (repeat with --prod and the prod redirect URI)
   npx convex env set --prod GOOGLE_CLIENT_ID <client-id>
   npx convex env set --prod GOOGLE_CLIENT_SECRET <client-secret>
   npx convex env set --prod GOOGLE_REDIRECT_URI https://<prod-deployment>.convex.site/gmail/callback
   ```

   Optional overrides:
   - `GMAIL_AMAZON_QUERY` — Gmail search used to find Amazon order emails. Defaults to
     `from:(auto-confirm@amazon.com OR order-update@amazon.com) subject:(order OR ordered) newer_than:1y`.
   - `GMAIL_POST_AUTH_URL` — fallback app URL to return to after consent. Normally unnecessary: the
     app passes its current origin through the OAuth `state`, so the callback redirects back to
     wherever you started.

7. In the app, click **Connect Gmail**, approve consent, then **Sync Amazon**.

### 6. OpenAI (AI classification)

Transactions are classified with merchant/category rules; anything the rules don't match stays
`unreviewed` for you to classify by hand. The backend also reserves an `OPENAI_API_KEY` env var and
an `ai` classification source for LLM-assisted classification. If/when you wire up an AI provider,
set the key in Convex:

```sh
npx convex env set OPENAI_API_KEY <openai-api-key>
```

Get a key from the [OpenAI dashboard](https://platform.openai.com/api-keys). It's optional — the app
works fully without it. To use a different provider, set the equivalent key and adjust the
classification code in `src/convex/`.

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
