# Where is my money going?

This app's job answers one simple question. Where the heck is my money going? It's great to have a budget, but does that budget match your reality? Even if you think you have everything planned out, how much are you actually spending OUTSIDE of your budget? And on what? This app shows you just that.

## Running it yourself

This app is free, BUT it is NOT hosted anywhere for you to use. I tried to make this so with light techincal knowledge you can use this yourself. Note that this isn't fully "local". It uses Convex as the database, because I love convex. But it's going to be YOUR convex account. The reason it's not fully local is because I want this app to keep itself updated with Convex scheduled functions. Below is what you need to run the app.

### 1. Prerequisites

- **Node.js 20+** and **npm**.
- A free **[Convex](https://convex.dev)** account (backend + database).
- A free **[Plaid](https://dashboard.plaid.com)** account for bank sync.
- A free **[Google Cloud](https://console.cloud.google.com/)** account for the Gmail/Amazon integration (optional).
- A free **[OpenAI](https://platform.openai.com)** or **[Anthropic](https://console.anthropic.com)** API key for AI transaction classification (optional).

### 2. Clone and install

```sh
git clone git@github.com:optikalefx/money.git
cd money
npm install
```

### 3. Set up Convex

Convex is the backend & database. Running the command below will setup the backend for you. It will ask you to log into convex and create a project.

```sh
npx convex dev
```

### 4. Run the app

```sh
npm run dev
```

The app is now running at http://localhost:5173. The integration credentials below are all stored
**server-side in Convex only** (set with `npx convex env set`), never in the frontend or in git.

## Authentication

The app is single-user and gated behind an owner password. **Every Convex function requires a valid
session**, so your financial data is never exposed to anyone who merely knows your deployment URL.

**How it works:** signing in POSTs your password to a Convex HTTP action (`/auth/login`), which
returns a short-lived signed **JWT** (RS256, ~30 days). The browser keeps that token and attaches it
to every Convex request; Convex verifies it against the public key published at
`${PUBLIC_CONVEX_SITE_URL}/.well-known/jwks.json` (note the `.convex.site` domain). There is **no
sign-up screen and no account table** — the password _is_ the credential and lives only as a Convex
env var. Because it's exchanged once for a token, your password is never sent on later requests.

**Provision it once** with the bundled script. It generates the RS256 signing key pair and sets all
three auth env vars for you, prompting for the password so it stays out of your shell history:

```sh
npm run auth:setup            # configures your dev deployment
npm run auth:setup -- --prod  # configures your production deployment
```

Re-run it anytime to rotate the key and/or password. Then open the app and sign in. To change only
the password later:

```sh
npx convex env set OWNER_PASSWORD <new-password>   # add --prod for production
```

## Integrations

This app syncs bank transactions from Plaid and Amazon order details from Gmail, and can classify
transactions with OpenAI. Each is optional and configured independently.

### 4. Plaid (bank transactions)

Plaid links your bank accounts and imports transactions. The client talks to Plaid entirely through
Convex actions, so all Plaid credentials live in Convex env vars.

1. **Create a Plaid account** and grab your keys from the [Plaid Dashboard](https://dashboard.plaid.com)
   under **Developers → Keys** (`client_id` and `production_secret`
2. **Set the Convex environment variables:**

   ```sh
   npx convex env set PLAID_CLIENT_ID <client-id>
   npx convex env set PLAID_SECRET <secret>
   npx convex env set PLAID_ENV production
   ```

   Repeat with `--prod` to configure your production Convex deployment.

3. In the app, click **Connect Plaid** to launch Plaid Link and connect an institution, then
   **Sync now** to import transactions.

On connect, the app requests up to **12 months** of history (Plaid's default is 90 days; the
institution may return less). Plaid delivers older history asynchronously and notifies a webhook at
`${PUBLIC_CONVEX_SITE_URL}/plaid/webhook`, which re-runs the sync automatically — so backfill keeps
flowing without a manual **Sync now**. No webhook setup is needed; the URL is registered on the link
token from `CONVEX_SITE_URL`. Note that both the 12-month depth and the webhook apply to **newly
linked** items, so re-link an existing connection to pick them up.

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

7. In the app, click **Connect Gmail**, approve consent, then **Sync Orders**.

### 6. AI classification (OpenAI or Anthropic)

Transactions are classified with merchant/category rules; anything the rules don't match stays
`unreviewed` for you to classify by hand. For LLM-assisted classification, the app supports both
**OpenAI** and **Anthropic** — set the key for whichever provider you want to use:

```sh
# OpenAI
npx convex env set OPENAI_API_KEY <openai-api-key>

# Anthropic
npx convex env set ANTHROPIC_API_KEY <anthropic-api-key>
```

Get a key from the [OpenAI dashboard](https://platform.openai.com/api-keys) or the
[Anthropic Console](https://console.anthropic.com/settings/keys). Then pick the provider and model
on the **Categories** page in the app (e.g. `gpt-4o-mini` for OpenAI, or `claude-haiku-4-5` for
Anthropic). It's optional — the app works fully without it.

## Environment variables

Here is the full list of env vars you need.

| Variable               | Required | Used for                                                                           |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- |
| `OWNER_PASSWORD`       | Yes      | Owner login password (set by `npm run auth:setup`).                                |
| `JWT_PRIVATE_KEY`      | Yes      | RS256 private key that signs session tokens (set by `npm run auth:setup`).         |
| `JWKS`                 | Yes      | Public key set Convex uses to verify session tokens (set by `npm run auth:setup`). |
| `PLAID_CLIENT_ID`      | Yes      | Plaid API client id.                                                               |
| `PLAID_SECRET`         | Yes      | Plaid API secret for the chosen environment.                                       |
| `PLAID_ENV`            | Yes      | Selects the Plaid API host: `sandbox`, `development`, or `production`.             |
| `GOOGLE_CLIENT_ID`     | No       | Gmail/Amazon OAuth (shared across deployments).                                    |
| `GOOGLE_CLIENT_SECRET` | No       | Gmail/Amazon OAuth (shared across deployments).                                    |
| `GOOGLE_REDIRECT_URI`  | No       | Gmail OAuth callback — must match the deployment's own `.convex.site`.             |
| `OPENAI_API_KEY`       | No       | AI-assisted transaction classification (OpenAI provider).                          |
| `ANTHROPIC_API_KEY`    | No       | AI-assisted transaction classification (Anthropic provider).                       |

## Building

> To deploy your app to a live URL instead of localhost, use Vercel or https://www.convex.dev/components/static-hosting
