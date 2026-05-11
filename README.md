# sparql-desktop
## introduction
ORCID-gated web app that lets researchers contribute SPARQL examples to
[`koetai/sparql-examples`](https://github.com/koetai/sparql-examples)
(a fork of [`sib-swiss/sparql-examples`](https://github.com/sib-swiss/sparql-examples)).

## Architecture

```
┌─────────────────────────────────────────────────┐
│  GitHub Pages — static JS SPA                   │
│  (Vite + React + YASGUI + sparqljs)             │
│                                                 │
│   • ORCID OAuth (PKCE, public client)           │
│   • Direct SPARQL queries to endpoints (CORS)   │
│   • Endpoint catalog from YummyData             │
└─────────────────────────┬───────────────────────┘
                          │ POST /api/submit
                          │ (Bearer: ORCID access token)
                          ▼
┌─────────────────────────────────────────────────┐
│  Cloudflare Worker — single endpoint            │
│                                                 │
│   • Verifies ORCID token via userinfo           │
│   • Rate-limits per ORCID iD (KV)               │
│   • Signs GitHub App JWT                        │
│   • Creates issue on koetai/sparql-examples     │
└─────────────────────────┬───────────────────────┘
                          │ Octokit
                          ▼
              GitHub API → koetai/sparql-examples
```

The Worker is the only place that holds secrets (GitHub App private key,
optionally an ORCID client secret if you use a confidential ORCID client).

## Repository layout

- `frontend/` — Vite + React + TypeScript SPA, deployed to GitHub Pages
- `worker/` — Cloudflare Worker, deployed with `wrangler`

## Local development

```bash
# Install
(cd frontend && npm install)
(cd worker && npm install)

# Copy env templates and fill in secrets
cp frontend/.env.example frontend/.env.local
cp worker/.dev.vars.example worker/.dev.vars

# Run both (in two terminals)
(cd worker && npm run dev)        # http://localhost:8787
(cd frontend && npm run dev)      # http://localhost:5173
```

## Required secrets

### ORCID
Register an application at <https://orcid.org/developer-tools> (or the sandbox
at <https://sandbox.orcid.org/developer-tools>). Set the redirect URI to:

- `http://localhost:5173` for dev
- `https://koetai.github.io/sparql-desktop/` for production

Choose a **public client** so PKCE-only flow works without a secret.

### GitHub App
Create a GitHub App owned by the `koetai` org with permissions:

- `Issues: write`
- `Contents: read`

Install it on `koetai/sparql-examples`. Note the App ID, generate a private key,
and note the Installation ID (visible in the App's installation URL).

### Cloudflare KV
Create a KV namespace for rate-limit counters and YummyData caching:

```bash
cd worker
npx wrangler kv namespace create RATE_LIMITS
# Paste the returned id into wrangler.toml
```

## Deployment

### Frontend (GitHub Pages)

```bash
cd frontend
npm run build
# Push dist/ to gh-pages branch, or set up a GitHub Action
```

### Worker

```bash
cd worker
npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # paste PEM
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler deploy
```

## Status

v1 scaffold complete. All client-side functionality is working in the dev preview.

- [x] Project structure (frontend + worker)
- [x] ORCID PKCE login (browser-side, public client, no secret)
- [x] Dev login (fake session — only enabled when `VITE_ORCID_CLIENT_ID` is empty)
- [x] YASGUI editor integration with full syntax highlighting & prefix autocomplete
- [x] sparqljs-based keyword extraction (prefix labels + class names from `?s a <Class>`)
- [x] Endpoint picker with native typeahead, fed by YummyData (60+ endpoints) via the Worker, with a static fallback of 10 well-known endpoints when the Worker is offline
- [x] Submission form with title/description/endpoint/query/keywords/AI-assisted toggle
- [x] AI-assisted path: manual paste of model name + original NL description + original AI query (for provenance)
- [x] Submit gate: query must parse AND return ≥1 row before Submit is enabled
- [x] Worker: ORCID token verification (against `${ORCID_BASE}/oauth/userinfo`)
- [x] Worker: per-ORCID daily submission rate limiting (KV-backed)
- [x] Worker: GitHub App authentication and issue creation on `koetai/sparql-examples`
- [x] Worker: YummyData fetch + 24h KV cache
- [ ] Production deployment (frontend to GitHub Pages, worker via `wrangler deploy`)
- [ ] GitHub Action for automatic frontend deploys
- [ ] Maintainer workflow for converting validated issues into Turtle files in `koetai/sparql-examples`

## Deployment checklist

1. Push this repo to `koetai/sparql-desktop` on GitHub
2. Register a **public** ORCID API client at <https://orcid.org/developer-tools> with redirect URI `https://koetai.github.io/sparql-desktop/`
3. Create a GitHub App owned by `koetai` with `Issues: write` and `Contents: read`; install it on `koetai/sparql-examples`
4. `cd worker && npx wrangler kv namespace create RATE_LIMITS` — paste the returned id into `wrangler.toml`
5. `npx wrangler secret put GITHUB_APP_PRIVATE_KEY` (and `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`)
6. `npx wrangler deploy` — note the deployed Worker URL
7. Set `VITE_ORCID_CLIENT_ID` and `VITE_WORKER_URL` for the frontend build, then `npm run build` and deploy `dist/` to GitHub Pages
8. Test end-to-end by submitting one query and confirming it appears as an issue on `koetai/sparql-examples`
