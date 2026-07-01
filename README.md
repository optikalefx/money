# Personal Money Tracker

A personal money tracker that separates expected spending from dynamic (unplanned) expenses. It
syncs bank transactions from Plaid and Amazon order details from Gmail, classifies them with
merchant/category rules, and surfaces dynamic spending on a date-filterable dashboard.

Built with SvelteKit + Convex, deployed on Vercel.

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.16.1 create --template minimal --types ts --add prettier eslint sveltekit-adapter="adapter:vercel" mcp="ide:claude-code+setup:remote" --install npm .
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Integrations

This app syncs bank transactions from Plaid and Amazon order details from Gmail. Both store
credentials server-side in Convex only.

### Gmail + Amazon (Google Cloud setup)

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

### Plaid

Set the Plaid environment variables in Convex (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, and
optionally `PLAID_REDIRECT_URI`). Then use **Connect Plaid** in the app to link an institution and
**Sync now** to import transactions.

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
