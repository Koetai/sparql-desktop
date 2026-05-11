# Deployment guide

This walks through getting `sparql-desktop` from local scaffold to production. Total time: about 30 minutes if nothing surprises you. Each step lists exact values to enter.

The goal is one verified end-to-end submission: ORCID-authenticated user → form → GitHub issue on `koetai/sparql-examples`.

## Prerequisites

- A GitHub account with **owner** access to the `koetai` organization
- A Cloudflare account ([free tier is enough](https://dash.cloudflare.com/sign-up))
- Node 20+ locally (you already have it — the scaffold is running)
- An ORCID iD ([orcid.org](https://orcid.org/register) if you don't have one)

## 1. Push the codebase to GitHub

```bash
cd /Users/andra/koetai/sparql-desktop
git init
git add -A
git commit -m "Initial scaffold"
gh repo create koetai/sparql-desktop --public --source=. --push
```

## 2. Register an ORCID public API client

Go to <https://orcid.org/developer-tools> (use <https://sandbox.orcid.org/developer-tools> first if you want to test against the sandbox).

Click **Register a public API client** and fill in:

| Field | Value |
|---|---|
| Name of your application | `SPARQL desktop` |
| Your website URL | `https://koetai.github.io/sparql-desktop/` |
| Description | `Contribute SPARQL examples to koetai/sparql-examples` |
| Redirect URIs | `https://koetai.github.io/sparql-desktop/` |

If you want to test locally too, add a second redirect URI: `http://localhost:5173/`.

After saving, you'll see a **Client ID** that looks like `APP-XXXXXXXXXXXXXXXX`. Keep this — you'll use it as `VITE_ORCID_CLIENT_ID`.

> **Note on public vs. confidential clients:** Choose **public** so the PKCE-only browser flow works without a client secret. If ORCID's UI only offers "trusted member API client" or similar, contact ORCID support — the public-client offering changes occasionally.

## 3. Create the GitHub App on the `koetai` org

Go to <https://github.com/organizations/koetai/settings/apps/new> and fill in:

| Field | Value |
|---|---|
| GitHub App name | `sparql-desktop-bot` (must be globally unique on GitHub) |
| Homepage URL | `https://koetai.github.io/sparql-desktop/` |
| Webhook → Active | **Uncheck** (we don't use webhooks) |

Under **Repository permissions**:

| Permission | Access |
|---|---|
| Issues | **Read and write** |
| Contents | **Read-only** |
| Metadata | Read-only (set automatically) |

Under **Where can this GitHub App be installed?** choose **Only on this account**.

Click **Create GitHub App**. On the next page:

1. Note the **App ID** (a number near the top) — this is `GITHUB_APP_ID`
2. Scroll to **Private keys** → **Generate a private key** → a `.pem` file downloads. This is `GITHUB_APP_PRIVATE_KEY` — keep it safe, you'll paste the full PEM content (including BEGIN/END lines) into a Cloudflare secret.
3. In the left sidebar, click **Install App** → next to `koetai` click **Install** → choose **Only select repositories** → pick `koetai/sparql-examples` → **Install**
4. After install, the URL in your browser bar contains the **Installation ID**, e.g. `https://github.com/settings/installations/12345678` — the number at the end is `GITHUB_APP_INSTALLATION_ID`

> If `koetai/sparql-examples` doesn't exist yet, fork `sib-swiss/sparql-examples` into the `koetai` org first.

## 4. Set up Cloudflare and create the KV namespace

```bash
cd worker
npx wrangler login
```

This opens a browser to authenticate. Once done:

```bash
npx wrangler kv namespace create RATE_LIMITS
```

The output contains an `id` like `id = "abc123def456..."`. Paste that id into `worker/wrangler.toml` replacing the placeholder:

```toml
[[kv_namespaces]]
binding = "RATE_LIMITS"
id = "abc123def456..."   # ← paste here
```

## 5. Set Worker secrets

From the `worker/` directory, run each of these and paste the value when prompted:

```bash
npx wrangler secret put GITHUB_APP_ID
# paste the numeric App ID

npx wrangler secret put GITHUB_APP_INSTALLATION_ID
# paste the numeric Installation ID

npx wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste the *entire* contents of the downloaded .pem file
# including -----BEGIN RSA PRIVATE KEY----- and -----END RSA PRIVATE KEY-----
# then press Enter and Ctrl+D
```

Also update `worker/wrangler.toml` `[vars]` section if needed:

```toml
[vars]
GITHUB_REPO = "koetai/sparql-examples"
ALLOWED_ORIGIN = "https://koetai.github.io"   # exact origin, no trailing slash
ORCID_BASE = "https://orcid.org"               # or sandbox.orcid.org for testing
```

## 6. Deploy the Worker

```bash
cd worker
npm run check    # dry-run, catches compile errors
npm run deploy   # actually deploys
```

Note the deployed URL Cloudflare prints — looks like `https://sparql-desktop-worker.<your-subdomain>.workers.dev`. This is `VITE_WORKER_URL`.

Smoke test from your terminal:

```bash
curl -i https://sparql-desktop-worker.<your-subdomain>.workers.dev/api/health
# Should return: HTTP/2 200 + {"ok":true}
```

## 7. Configure GitHub Pages and frontend secrets

In the `koetai/sparql-desktop` repo on GitHub:

1. **Settings → Pages → Build and deployment → Source** → choose **GitHub Actions**
2. **Settings → Secrets and variables → Actions → New repository secret** — add these two:

| Name | Value |
|---|---|
| `VITE_ORCID_CLIENT_ID` | `APP-XXXXXXXXXXXXXXXX` (from step 2) |
| `VITE_WORKER_URL` | `https://sparql-desktop-worker.<your-subdomain>.workers.dev` |

## 8. Deploy the frontend

Push any commit (e.g. an empty README change) to the `main` branch, or run the workflow manually from **Actions → Deploy frontend to GitHub Pages → Run workflow**.

Once the action finishes (~2 minutes), visit:

`https://koetai.github.io/sparql-desktop/`

## 9. End-to-end smoke test

1. Click **Sign in with ORCID** — you should be redirected to ORCID, after auth back to the desktop with your name in the header
2. The endpoint picker hint should now read `60+ endpoints from YummyData` (not "Worker offline")
3. The default UniProt query should be there; click **Test query** → ✓ should appear with a row count
4. Add a title like "End-to-end test"
5. Click **Submit to koetai/sparql-examples**
6. The page should show a success message with a link to a new issue on `koetai/sparql-examples`
7. Open the issue — the body should contain your ORCID iD, the query, and the keywords

If any step fails, the most common causes:

| Symptom | Likely cause |
|---|---|
| ORCID redirect bounces back without `?code=` | Redirect URI in step 2 doesn't match what the frontend computes — paste the *exact* URL including the trailing slash |
| `403 Forbidden` from Worker | `ALLOWED_ORIGIN` in `wrangler.toml` doesn't match the Pages origin |
| `401 Missing ORCID bearer token` | Browser session lost — sign out and sign in again |
| `Invalid ORCID token` | If you used the sandbox client, set `ORCID_BASE=https://sandbox.orcid.org` in the Worker too |
| `Bad credentials` from GitHub | The App's installation ID is wrong, or the App isn't installed on `koetai/sparql-examples` |
| Issue doesn't appear | Check `wrangler tail` output — likely a GitHub permission issue (Issues: write must be granted) |

Once a real submission lands successfully, you've verified the full pipeline.
