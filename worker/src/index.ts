import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface Env {
  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ORCID_CLIENT_SECRET: string;
  // Vars
  GITHUB_REPO: string;
  ALLOWED_ORIGIN: string;
  ORCID_BASE: string;
  YUMMYDATA_CACHE_TTL_SECONDS: string;
  DAILY_SUBMISSION_LIMIT: string;
  // Curator allowlist — comma-separated ORCID iDs that may use /api/curator/*.
  CURATOR_ORCIDS: string;
  // Default branch of the data repo (e.g., "master").
  GITHUB_REPO_DEFAULT_BRANCH: string;
  // KV
  RATE_LIMITS: KVNamespace;
}

interface SubmissionBody {
  // 'working' (default) = the contributor has a query they tested; lands as
  // ready-to-merge. 'request' = the contributor describes what they want in
  // natural language, may include a failed AI attempt; lands as needs-expert.
  mode?: 'working' | 'request';
  title: string;
  description: string;
  endpoint: string;
  // Extra endpoints the query is also valid against. Rendered into the issue
  // body and emitted as additional schema:target IRIs when the curator
  // publishes the example.
  additionalEndpoints?: string[];
  query: string;
  keywords: string[];
  prefixes: Record<string, string>;
  aiSuggested?: boolean;
  aiModel?: string;
  naturalLanguageDescription?: string;
  originalAiQuery?: string;
  selectedAffiliationId?: string | null;
}

const AFFILIATION_NONE = '__none__';

interface OrcidIdentity {
  orcid: string;
  name: string;
}

interface Affiliation {
  id: string;            // stable identifier — ORCID put-code (or fallback hash)
  current: boolean;      // currently active (no end-date) vs past
  name: string;
  rorUrl?: string;       // canonical ROR identifier (when ORCID has it)
  gridId?: string;       // GRID identifier (legacy, no ROR mapping yet)
  ringgoldId?: string;   // Ringgold (legacy publisher-side identifier)
  source?: string;       // ROR | GRID | RINGGOLD | LEI | etc.
  role?: string;
  department?: string;
  startYear?: number;
  endYear?: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(env.ALLOWED_ORIGIN);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true }, cors);
      }
      if (url.pathname === '/api/yummydata' && req.method === 'GET') {
        return await handleYummyData(env, cors);
      }
      if (url.pathname === '/api/auth/orcid' && req.method === 'POST') {
        return await handleOrcidTokenExchange(req, env, cors);
      }
      if (url.pathname === '/api/affiliations' && req.method === 'GET') {
        return await handleAffiliations(req, env, cors);
      }
      if (url.pathname === '/api/sparql-proxy' && req.method === 'POST') {
        return await handleSparqlProxy(req, env, cors);
      }
      if (url.pathname === '/api/submit' && req.method === 'POST') {
        return await handleSubmit(req, env, cors);
      }
      if (url.pathname === '/api/curator/me' && req.method === 'GET') {
        return await handleCuratorMe(req, env, cors);
      }
      if (url.pathname === '/api/curator/issues' && req.method === 'GET') {
        return await handleCuratorIssues(req, env, cors);
      }
      const issueMatch = url.pathname.match(/^\/api\/curator\/issues\/(\d+)$/);
      if (issueMatch && req.method === 'GET') {
        return await handleCuratorIssue(req, env, cors, parseInt(issueMatch[1], 10));
      }
      if (url.pathname === '/api/curator/folders' && req.method === 'GET') {
        return await handleCuratorFolders(req, env, cors);
      }
      if (url.pathname === '/api/curator/publish' && req.method === 'POST') {
        return await handleCuratorPublish(req, env, cors);
      }
      if (url.pathname === '/api/curator/reject' && req.method === 'POST') {
        return await handleCuratorReject(req, env, cors);
      }
      return text('Not Found', 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return text((err as Error).message || 'Internal Server Error', 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data: unknown, cors: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function text(body: string, status: number, cors: HeadersInit): Response {
  return new Response(body, { status, headers: cors });
}

async function verifyOrcidToken(token: string, env: Env): Promise<OrcidIdentity> {
  const res = await fetch(`${env.ORCID_BASE}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ORCID token verification failed (${res.status})`);
  const data = (await res.json()) as { sub: string; name?: string; given_name?: string };
  return { orcid: data.sub, name: data.name ?? data.given_name ?? 'ORCID user' };
}

// Fetches the contributor's public affiliations from ORCID and extracts ROR
// identifiers where available. Failures are non-fatal: an empty list is
// returned so submission still succeeds even if ORCID is unreachable.
async function fetchOrcidAffiliations(orcid: string): Promise<{
  current: Affiliation[];
  past: Affiliation[];
}> {
  try {
    const res = await fetch(`https://pub.orcid.org/v3.0/${orcid}/employments`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { current: [], past: [] };
    const data = (await res.json()) as {
      'affiliation-group'?: Array<{
        summaries?: Array<{ 'employment-summary'?: OrcidEmploymentSummary }>;
      }>;
    };
    const summaries: OrcidEmploymentSummary[] = [];
    for (const g of data['affiliation-group'] ?? []) {
      for (const s of g.summaries ?? []) {
        if (s['employment-summary']) summaries.push(s['employment-summary']);
      }
    }
    const current: Affiliation[] = [];
    const past: Affiliation[] = [];
    for (const e of summaries) {
      const aff = toAffiliation(e);
      if (e['end-date']) past.push(aff);
      else current.push(aff);
    }
    return { current, past };
  } catch (err) {
    console.error('Failed to fetch ORCID affiliations:', err);
    return { current: [], past: [] };
  }
}

interface OrcidEmploymentSummary {
  'put-code'?: number;
  organization?: {
    name?: string;
    'disambiguated-organization'?: {
      'disambiguated-organization-identifier'?: string;
      'disambiguation-source'?: string;
    };
  };
  'role-title'?: string | null;
  'department-name'?: string | null;
  'start-date'?: { year?: { value?: string } };
  'end-date'?: { year?: { value?: string } } | null;
}

function toAffiliation(e: OrcidEmploymentSummary): Affiliation {
  const org = e.organization ?? {};
  const dis = org['disambiguated-organization'] ?? {};
  const rawId = dis['disambiguated-organization-identifier'];
  const source = dis['disambiguation-source']?.toUpperCase();
  const endYear = numOrUndef(e['end-date']?.year?.value);

  const aff: Affiliation = {
    // put-code is stable per ORCID record; fall back to a deterministic
    // pseudo-id only if missing (older records sometimes lack it).
    id: e['put-code']
      ? String(e['put-code'])
      : `pseudo:${org.name ?? '?'}:${e['start-date']?.year?.value ?? '?'}`,
    current: !e['end-date'],
    name: org.name ?? 'Unknown organization',
    source,
    role: e['role-title'] ?? undefined,
    department: e['department-name'] ?? undefined,
    startYear: numOrUndef(e['start-date']?.year?.value),
    endYear,
  };
  if (rawId && source === 'ROR') {
    aff.rorUrl = rawId.startsWith('http') ? rawId : `https://ror.org/${rawId}`;
  } else if (rawId && source === 'GRID') {
    aff.gridId = rawId;
  } else if (rawId && source === 'RINGGOLD') {
    aff.ringgoldId = rawId;
  }
  return aff;
}

function numOrUndef(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

async function checkAndIncrementRateLimit(orcid: string, env: Env): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${orcid}:${day}`;
  const limit = parseInt(env.DAILY_SUBMISSION_LIMIT || '10', 10);
  const current = parseInt((await env.RATE_LIMITS.get(key)) ?? '0', 10);
  if (current >= limit) {
    throw new Error(`Daily submission limit (${limit}) reached for this ORCID iD`);
  }
  await env.RATE_LIMITS.put(key, String(current + 1), { expirationTtl: 86400 * 2 });
}

// Server-side SPARQL proxy. Lets the browser query endpoints it can't reach
// directly — HTTP-only endpoints (mixed-content blocked on our HTTPS origin)
// and endpoints without permissive CORS. ORCID-authenticated to avoid being
// an open proxy. Forwards the query as POST form-encoded (handles long
// queries) and relays the SPARQL JSON results back with our CORS headers.
async function handleSparqlProxy(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return text('Missing ORCID bearer token', 401, cors);
  }
  await verifyOrcidToken(auth.slice(7), env);

  const { endpoint, query } = (await req.json()) as {
    endpoint?: string;
    query?: string;
  };
  if (!endpoint || !query) {
    return text('Missing endpoint or query', 400, cors);
  }

  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    return text('Invalid endpoint URL', 400, cors);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return text('Endpoint must use http or https', 400, cors);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: new URLSearchParams({ query }),
    });
  } catch (err) {
    return text(`Could not reach endpoint: ${(err as Error).message}`, 502, cors);
  }

  const bodyText = await upstream.text();
  return new Response(bodyText, {
    status: upstream.ok ? 200 : upstream.status,
    headers: {
      ...cors,
      'Content-Type':
        upstream.headers.get('Content-Type') ?? 'application/sparql-results+json',
    },
  });
}

async function handleAffiliations(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return text('Missing ORCID bearer token', 401, cors);
  }
  const identity = await verifyOrcidToken(auth.slice(7), env);
  const aff = await fetchOrcidAffiliations(identity.orcid);
  return json(
    {
      orcid: identity.orcid,
      current: aff.current,
      past: aff.past,
    },
    cors,
  );
}

async function handleSubmit(req: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return text('Missing ORCID bearer token', 401, cors);
  }
  const identity = await verifyOrcidToken(auth.slice(7), env);
  await checkAndIncrementRateLimit(identity.orcid, env);

  const body = (await req.json()) as SubmissionBody;
  const mode: 'working' | 'request' = body.mode === 'request' ? 'request' : 'working';
  if (mode === 'working') {
    if (!body.query || !body.endpoint || !body.title) {
      return text('Missing required fields: title, endpoint, query', 400, cors);
    }
  } else {
    // request mode — natural-language description is the primary content;
    // the query may be empty or partial. Endpoint is still required so an
    // expert knows where the eventual query should run.
    if (!body.title || !body.endpoint || !body.naturalLanguageDescription?.trim()) {
      return text(
        'Missing required fields for a request: title, endpoint, natural-language description',
        400,
        cors,
      );
    }
    if (!body.aiModel?.trim()) {
      return text('Request mode requires the LLM model name', 400, cors);
    }
  }

  // Fetch the contributor's public affiliations so we can validate their
  // explicit selection. The frontend gets the same list from /api/affiliations.
  const affiliations = await fetchOrcidAffiliations(identity.orcid);
  const all = [...affiliations.current, ...affiliations.past];

  let selectedAffiliation: Affiliation | null = null;
  if (body.selectedAffiliationId && body.selectedAffiliationId !== AFFILIATION_NONE) {
    const match = all.find((a) => a.id === body.selectedAffiliationId);
    if (!match) {
      return text(
        'Selected affiliation does not match any of your ORCID affiliations. Refresh the page and pick again.',
        400,
        cors,
      );
    }
    selectedAffiliation = match;
  }

  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    },
  });

  const labels: string[] = [];
  if (mode === 'request') {
    labels.push('needs-expert', 'ai-assisted');
  } else {
    labels.push('ready-to-merge');
    if (body.aiSuggested) labels.push('ai-assisted');
  }

  const issue = await octokit.issues.create({
    owner,
    repo,
    title: body.title,
    body: renderIssueBody(body, identity, selectedAffiliation, mode),
    labels,
  });

  return json({ url: issue.data.html_url, number: issue.data.number }, cors);
}

function renderIssueBody(
  body: SubmissionBody,
  identity: OrcidIdentity,
  affiliation: Affiliation | null,
  mode: 'working' | 'request',
): string {
  const lines: string[] = [];

  if (mode === 'request') {
    lines.push(
      '> ⚠️ This is a **request for an expert** to write or fix the SPARQL query.',
      '> The contributor described what they want in natural language and (optionally) provides an LLM-generated draft that did not yet work.',
      '',
    );
  }

  lines.push(
    '## Contributor',
    `**ORCID iD:** [${identity.orcid}](https://orcid.org/${identity.orcid})`,
    `**Name:** ${identity.name}`,
  );

  if (affiliation) {
    lines.push('', '### Affiliation', renderAffiliationLine(affiliation));
  } else {
    lines.push(
      '',
      '### Affiliation',
      '_None selected — contributor either had no relevant affiliation in their ORCID record, or chose not to associate one with this submission._',
    );
  }

  const allEndpoints = [
    body.endpoint,
    ...(body.additionalEndpoints ?? []).map((s) => s.trim()).filter(Boolean),
  ];
  if (allEndpoints.length > 1) {
    lines.push('', '## Endpoints', ...allEndpoints.map((e) => `- ${e}`));
  } else {
    lines.push('', '## Endpoint', body.endpoint);
  }

  if (mode === 'request') {
    lines.push(
      '',
      '## What the contributor wants to ask',
      body.naturalLanguageDescription || '_(none provided)_',
    );
    if (body.aiModel) {
      lines.push(
        '',
        '## LLM tried',
        `**Model:** ${body.aiModel}`,
      );
    }
    if (body.query?.trim()) {
      lines.push(
        '',
        '### LLM-generated draft (not yet working)',
        '```sparql',
        body.query,
        '```',
      );
    } else {
      lines.push('', '### LLM-generated draft', '_(none — contributor asked for help without an attempt)_');
    }
  } else {
    lines.push(
      '',
      '## Description',
      body.description || '_(none provided)_',
      '',
      '## Query',
      '```sparql',
      body.query,
      '```',
    );
  }

  lines.push(
    '',
    '## Keywords',
    body.keywords.length > 0
      ? body.keywords.map((k) => `\`${k}\``).join(' ')
      : '_(none)_',
  );

  if (body.prefixes && Object.keys(body.prefixes).length > 0) {
    lines.push('', '## Prefixes');
    for (const [p, iri] of Object.entries(body.prefixes)) {
      lines.push(`- \`${p}: <${iri}>\``);
    }
  }

  if (mode === 'working' && body.aiSuggested) {
    lines.push(
      '',
      '## AI-assisted submission',
      `**Model used:** ${body.aiModel ?? '_(not specified)_'}`,
      '',
      '### Original natural language description',
      body.naturalLanguageDescription ?? '_(none)_',
    );
    if (body.originalAiQuery && body.originalAiQuery !== body.query) {
      lines.push(
        '',
        '### Original AI suggestion',
        '```sparql',
        body.originalAiQuery,
        '```',
      );
    }
  }

  lines.push('', '---', '_Submitted via [sparql-desktop](https://koetai.github.io/sparql-desktop/)._');
  return lines.join('\n');
}

function renderAffiliationLine(a: Affiliation): string {
  const role = [a.role, a.department].filter(Boolean).join(', ');
  const prefix = role ? `${role}, ` : '';
  const span =
    a.startYear || a.endYear
      ? ` _(${a.startYear ?? '?'}–${a.endYear ?? 'present'})_`
      : '';
  if (a.rorUrl) return `- ${prefix}[${a.name}](${a.rorUrl}) (ROR)${span}`;
  if (a.gridId) return `- ${prefix}${a.name} (GRID: \`${a.gridId}\`)${span}`;
  if (a.ringgoldId) return `- ${prefix}${a.name} (Ringgold: \`${a.ringgoldId}\`)${span}`;
  return `- ${prefix}${a.name}${span}`;
}

interface YummyDataRecord {
  id: number;
  name: string;
  endpoint_url: string;
  score?: number;
  alive?: boolean;
  service_description?: boolean;
  rank?: string;
}

// Server-to-server relay for the ORCID OAuth token exchange. Two reasons it
// runs in the Worker rather than the browser:
//   1. ORCID's /oauth/token has no CORS, so the browser can't POST to it.
//   2. ORCID requires a client_secret on the exchange (yes, even though they
//      call it a "public" API client). The secret lives as a Cloudflare
//      secret and never reaches the browser.
// PKCE (code_verifier) is still used as an additional protection — both the
// secret and the verifier are sent.
async function handleOrcidTokenExchange(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const body = (await req.json()) as {
    code?: string;
    code_verifier?: string;
    client_id?: string;
    redirect_uri?: string;
  };
  if (!body.code || !body.code_verifier || !body.client_id || !body.redirect_uri) {
    return text(
      'Missing required fields: code, code_verifier, client_id, redirect_uri',
      400,
      cors,
    );
  }
  if (!env.ORCID_CLIENT_SECRET) {
    return text(
      'Worker secret ORCID_CLIENT_SECRET is not set — run: wrangler secret put ORCID_CLIENT_SECRET',
      500,
      cors,
    );
  }

  const orcidRes = await fetch(`${env.ORCID_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: body.client_id,
      client_secret: env.ORCID_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: body.code,
      redirect_uri: body.redirect_uri,
      code_verifier: body.code_verifier,
    }),
  });
  if (!orcidRes.ok) {
    const errText = await orcidRes.text();
    return text(
      `ORCID token exchange failed (${orcidRes.status}): ${errText.slice(0, 500)}`,
      orcidRes.status,
      cors,
    );
  }
  const data = (await orcidRes.json()) as Record<string, unknown>;
  return json(data, cors);
}

async function handleYummyData(env: Env, cors: HeadersInit): Promise<Response> {
  const cached = await env.RATE_LIMITS.get('yummydata:cache:v1');
  if (cached) {
    return new Response(cached, {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }
  const upstream = await fetch('https://yummydata.org/endpoint.json', {
    headers: { Accept: 'application/json' },
  });
  if (!upstream.ok) {
    return text(`YummyData upstream returned ${upstream.status}`, 502, cors);
  }
  const data = (await upstream.json()) as { data?: YummyDataRecord[] };
  const endpoints = (data.data ?? [])
    .filter((e) => e.endpoint_url && e.alive !== false)
    .map((e) => ({
      name: e.name,
      url: e.endpoint_url,
      rank: e.rank ?? null,
      score: e.score ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = JSON.stringify({
    endpoints,
    fetchedAt: new Date().toISOString(),
  });
  const ttl = parseInt(env.YUMMYDATA_CACHE_TTL_SECONDS || '86400', 10);
  await env.RATE_LIMITS.put('yummydata:cache:v1', payload, { expirationTtl: ttl });
  return new Response(payload, {
    headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
  });
}

// =====================================================================
// Curator endpoints — for maintainers turning issues into Turtle PRs.
// Gated by ORCID allowlist (CURATOR_ORCIDS). Match the upstream
// sib-swiss/sparql-examples schema so output files validate cleanly.
// =====================================================================

interface ParsedIssue {
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
  contributorOrcid?: string;
  contributorName?: string;
  affiliation?: string;
  endpoint?: string;
  additionalEndpoints?: string[];
  description?: string;
  query?: string;
  keywords: string[];
  aiModel?: string;
  naturalLanguageDescription?: string;
  originalAiQuery?: string;
  rawBody: string;
}

interface PublishRequest {
  issueNumber: number;
  folder: string; // e.g., "UniProt" or "idr-muenster"
  slug: string; // e.g., "list_uniprot_proteins"
  label: string; // rdfs:label
  comment: string; // rdfs:comment (HTML allowed)
  endpoint: string;
  additionalEndpoints?: string[];
  query: string;
  keywords: string[];
  sequenceNumber?: number; // optional file prefix, e.g. "100"
}

async function requireCurator(
  req: Request,
  env: Env,
): Promise<OrcidIdentity> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing ORCID bearer token');
  }
  const identity = await verifyOrcidToken(auth.slice(7), env);
  const allowed = (env.CURATOR_ORCIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(identity.orcid)) {
    throw new HttpError(
      403,
      `ORCID iD ${identity.orcid} is not on the curator allowlist`,
    );
  }
  return identity;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function buildOctokit(env: Env): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    },
  });
}

async function handleCuratorMe(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  try {
    const me = await requireCurator(req, env);
    return json({ orcid: me.orcid, name: me.name, isCurator: true }, cors);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      // 200 with isCurator:false so the frontend can hide curator UI without
      // a noisy error.
      const fallback = await verifyOrcidToken(
        (req.headers.get('Authorization') ?? '').slice(7),
        env,
      ).catch(() => null);
      return json(
        {
          orcid: fallback?.orcid ?? null,
          name: fallback?.name ?? null,
          isCurator: false,
        },
        cors,
      );
    }
    throw e;
  }
}

async function handleCuratorIssues(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  await requireCurator(req, env);
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = buildOctokit(env);
  const url = new URL(req.url);
  const state = (url.searchParams.get('state') ?? 'open') as
    | 'open'
    | 'closed'
    | 'all';
  const label = url.searchParams.get('label') ?? '';
  const issues = await octokit.issues.listForRepo({
    owner,
    repo,
    state,
    labels: label || undefined,
    per_page: 100,
  });
  // Skip PRs (they're issues too) and reduce to the fields the curator UI needs.
  const list = issues.data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      htmlUrl: i.html_url,
      state: i.state,
      labels: (i.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : l.name))
        .filter(Boolean),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      submitter: i.user?.login ?? null,
    }));
  return json({ issues: list }, cors);
}

async function handleCuratorIssue(
  req: Request,
  env: Env,
  cors: HeadersInit,
  issueNumber: number,
): Promise<Response> {
  await requireCurator(req, env);
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = buildOctokit(env);
  const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  if (data.pull_request) {
    return text(`#${issueNumber} is a pull request, not an issue`, 404, cors);
  }
  const parsed = parseIssueBody(data.body ?? '');
  const result: ParsedIssue = {
    ...parsed,
    number: data.number,
    title: data.title,
    htmlUrl: data.html_url,
    labels: (data.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .filter(Boolean) as string[],
    rawBody: data.body ?? '',
  };
  return json(result, cors);
}

async function handleCuratorFolders(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  await requireCurator(req, env);
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = buildOctokit(env);
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: 'examples',
  });
  if (!Array.isArray(data)) {
    return json({ folders: [] }, cors);
  }
  const folders = data
    .filter((e) => e.type === 'dir')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return json({ folders }, cors);
}

async function handleCuratorPublish(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const curator = await requireCurator(req, env);
  const body = (await req.json()) as PublishRequest;
  const errs: string[] = [];
  if (!body.issueNumber) errs.push('issueNumber');
  if (!body.folder?.trim()) errs.push('folder');
  if (!body.slug?.trim()) errs.push('slug');
  if (!body.label?.trim()) errs.push('label');
  if (!body.query?.trim()) errs.push('query');
  if (!body.endpoint?.trim()) errs.push('endpoint');
  if (errs.length) return text(`Missing: ${errs.join(', ')}`, 400, cors);

  const slug = sanitizeSlug(body.slug);
  const folder = body.folder.trim().replace(/[^A-Za-z0-9_.-]/g, '');
  const sequence =
    typeof body.sequenceNumber === 'number' && body.sequenceNumber > 0
      ? String(body.sequenceNumber).padStart(3, '0') + '_'
      : '';
  const fileName = `${sequence}${slug}.ttl`;
  const path = `examples/${folder}/${fileName}`;
  const turtle = generateTurtle({
    endpoint: body.endpoint.trim(),
    additionalEndpoints: (body.additionalEndpoints ?? [])
      .map((e) => e.trim())
      .filter(Boolean),
    slug,
    label: body.label.trim(),
    comment: body.comment?.trim() ?? '',
    query: body.query,
    keywords: body.keywords ?? [],
  });

  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = buildOctokit(env);
  const baseBranch = env.GITHUB_REPO_DEFAULT_BRANCH || 'master';
  const branchName = `curate/issue-${body.issueNumber}-${slug}`.slice(0, 240);

  // Get base branch SHA
  let baseSha: string;
  try {
    const refRes = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    baseSha = refRes.data.object.sha;
  } catch (e) {
    return text(
      `Could not read base branch ${baseBranch}: ${(e as Error).message}`,
      502,
      cors,
    );
  }

  // Create or reuse the branch
  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  } catch (e) {
    // 422 = branch exists; that's fine, we'll commit on top of it.
    if (!String((e as Error).message).includes('Reference already exists')) {
      return text(
        `Could not create branch ${branchName}: ${(e as Error).message}. The GitHub App may be missing the Contents:write permission.`,
        502,
        cors,
      );
    }
  }

  // Get the file SHA if it already exists on that branch (idempotent re-publish)
  let existingSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branchName,
    });
    if (!Array.isArray(existing.data) && 'sha' in existing.data) {
      existingSha = existing.data.sha;
    }
  } catch {
    /* file doesn't exist yet — fine */
  }

  // Write the file
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch: branchName,
      message: `Curate: ${body.label.trim()} (from issue #${body.issueNumber})`,
      content: btoa(unescape(encodeURIComponent(turtle))),
      sha: existingSha,
    });
  } catch (e) {
    return text(
      `Could not write file: ${(e as Error).message}. The GitHub App may be missing the Contents:write permission.`,
      502,
      cors,
    );
  }

  // Open the PR (or find an existing one for this branch)
  const prTitle = `Curate: ${body.label.trim()} (closes #${body.issueNumber})`;
  const prBody = [
    `Closes #${body.issueNumber}.`,
    '',
    `Curated by [${curator.name}](https://orcid.org/${curator.orcid}) via sparql-desktop.`,
    '',
    `**Target endpoint:** ${body.endpoint}`,
    `**File:** \`${path}\``,
  ].join('\n');

  let prUrl: string;
  let prNumber: number;
  let prWasReused = false;
  try {
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: branchName,
      base: baseBranch,
      title: prTitle,
      body: prBody,
    });
    prUrl = pr.data.html_url;
    prNumber = pr.data.number;
  } catch (e) {
    // 422 = PR already exists for this branch — look it up.
    const msg = String((e as Error).message);
    if (msg.includes('A pull request already exists')) {
      const list = await octokit.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
        state: 'open',
      });
      if (list.data.length > 0) {
        prUrl = list.data[0].html_url;
        prNumber = list.data[0].number;
        prWasReused = true;
      } else {
        return text(
          `PR conflict, but none returned by list: ${msg}. App may be missing Pull requests:write.`,
          502,
          cors,
        );
      }
    } else {
      return text(
        `Could not open PR: ${msg}. The GitHub App may be missing the Pull requests:write permission.`,
        502,
        cors,
      );
    }
  }

  // Comment on the source issue with the PR link only on the first publish.
  // Re-publishes (curator clicking Publish again to fix the file) skip the
  // comment to avoid spamming the issue thread.
  if (!prWasReused) try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: body.issueNumber,
      body: `Curated as PR #${prNumber}: ${prUrl}. Will auto-close when the PR merges.`,
    });
  } catch {
    /* non-fatal */
  }

  return json({ prUrl, prNumber, path, reused: prWasReused }, cors);
}

// ---------------------- Issue body parser ----------------------
// Parses the structured Markdown the Worker itself writes when creating
// submission issues. Tolerant of missing sections.
function parseIssueBody(body: string): Omit<ParsedIssue, 'number' | 'title' | 'htmlUrl' | 'labels' | 'rawBody'> {
  const out: Omit<ParsedIssue, 'number' | 'title' | 'htmlUrl' | 'labels' | 'rawBody'> = {
    keywords: [],
  };
  if (!body) return out;

  const orcidMatch = body.match(/\*\*ORCID iD:\*\*\s*\[([\d-]+X?)\]/i);
  if (orcidMatch) out.contributorOrcid = orcidMatch[1];

  const nameMatch = body.match(/\*\*Name:\*\*\s*([^\n]+)/);
  if (nameMatch) out.contributorName = nameMatch[1].trim();

  const affLine = body.match(/### Affiliation\s*\n+(- [^\n]+)/);
  if (affLine) out.affiliation = affLine[1].replace(/^- /, '').trim();

  // Handles both legacy single-line `## Endpoint\n<url>` and the new
  // `## Endpoints\n- <url1>\n- <url2>` bulleted form.
  const endpointSection =
    extractSection(body, 'Endpoints') ?? extractSection(body, 'Endpoint');
  if (endpointSection) {
    const urls = endpointSection
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^-\s+/, ''))
      .filter((l) => /^https?:\/\//i.test(l));
    if (urls.length > 0) {
      out.endpoint = urls[0];
      if (urls.length > 1) out.additionalEndpoints = urls.slice(1);
    }
  }

  const description = extractSection(body, 'Description');
  if (description && !/^_\(none/.test(description.trim())) {
    out.description = description.trim();
  }

  // request-mode equivalent
  const nlDesc =
    extractSection(body, 'What the contributor wants to ask') ??
    extractSection(body, 'Original natural language description');
  if (nlDesc && !/^_\(none/.test(nlDesc.trim())) {
    out.naturalLanguageDescription = nlDesc.trim();
    if (!out.description) out.description = nlDesc.trim();
  }

  // Extract sparql code blocks — tolerant of CRLF, trailing spaces on the
  // opening fence, and the closing ``` being followed by anything on its line.
  const fenceRe = /```sparql[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  const allBlocks = [...body.matchAll(fenceRe)];
  if (allBlocks[0]) out.query = allBlocks[0][1];
  if (allBlocks[1]) out.originalAiQuery = allBlocks[1][1];

  const keywordsSec = extractSection(body, 'Keywords');
  if (keywordsSec) {
    const tags = [...keywordsSec.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    if (tags.length > 0) out.keywords = tags;
  }

  const model = body.match(/\*\*Model used:\*\*\s*([^\n_]+)/);
  if (model) {
    const v = model[1].trim();
    if (v && !v.startsWith('_(')) out.aiModel = v;
  }
  const modelAlt = body.match(/\*\*Model:\*\*\s*([^\n_]+)/);
  if (!out.aiModel && modelAlt) out.aiModel = modelAlt[1].trim();

  return out;
}

function extractSection(body: string, heading: string): string | undefined {
  const re = new RegExp(`##+\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`);
  const m = body.match(re);
  return m ? m[1].trim() : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------- Turtle generator ----------------------
// Matches the sib-swiss / koetai/sparql-examples schema seen in existing files
// (e.g., examples/UniProt/100_uniprot_organelles_or_plasmids.ttl).
function generateTurtle(input: {
  endpoint: string;
  additionalEndpoints?: string[];
  slug: string;
  label: string;
  comment: string;
  query: string;
  keywords: string[];
}): string {
  const exBase = exNamespaceFor(input.endpoint);
  const keywords =
    input.keywords.length > 0
      ? input.keywords.map((k) => `"${escapeTtl(k)}"`).join(' , ')
      : '"example"';
  const labelTtl = escapeTtl(input.label);
  const commentTtl = escapeTtl(input.comment || input.label);
  // Keep inline PREFIX declarations (each example self-describes), but
  // de-duplicate. LLM-generated queries sometimes carry two stacked PREFIX
  // blocks; RDF4J rejects duplicate declarations.
  const query = dedupeSparqlPrologue(input.query);

  // The SHACL test `testAllServicesAnnotated` requires every `SERVICE <IRI>`
  // in the query to be reflected as `spex:federatesWith <IRI>`.
  const services = extractServiceIris(query);
  const federatesLines = services
    .map((iri) => `    spex:federatesWith <${iri}> ;\n`)
    .join('');

  return `@prefix ex: <${exBase}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema: <https://schema.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix spex: <https://purl.expasy.org/sparql-examples/ontology#> .

ex:${input.slug} a sh:SPARQLExecutable,
        sh:SPARQLSelectExecutable ;
    rdfs:label "${labelTtl}" ;
    rdfs:comment "${commentTtl}"^^rdf:HTML ;
${federatesLines}    sh:select """${query}""" ;
    schema:keywords ${keywords} ;
    schema:target ${targets(input.endpoint, input.additionalEndpoints).join(' , ')} .
`;
}

function targets(primary: string, extras?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [primary, ...(extras ?? [])]) {
    const u = url.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(`<${u}>`);
  }
  return out;
}

function extractServiceIris(query: string): string[] {
  const re = /\bSERVICE\s+(?:SILENT\s+)?<([^>]+)>/gi;
  const out = new Set<string>();
  for (const m of query.matchAll(re)) out.add(m[1]);
  return [...out];
}

// De-duplicates PREFIX declarations in the SPARQL prologue, keeping the
// first occurrence of each prefix name. Mirrors frontend/src/lib/turtle.ts —
// keep them in sync.
function dedupeSparqlPrologue(query: string): string {
  const lines = query.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  const prefixLine = /^\s*prefix\s+(\w*)\s*:\s*<[^>]*>\s*\.?\s*$/i;
  const baseLine = /^\s*base\s+<[^>]*>\s*\.?\s*$/i;
  let inPrologue = true;
  for (const line of lines) {
    if (inPrologue) {
      const m = line.match(prefixLine);
      if (m) {
        const name = m[1].toLowerCase();
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(line);
        continue;
      }
      if (baseLine.test(line) || line.trim() === '' || line.trim().startsWith('#')) {
        out.push(line);
        continue;
      }
      inPrologue = false;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

// Drops the SPARQL prologue (PREFIX / BASE) from a query string.
// Mirrors frontend/src/lib/turtle.ts — keep them in sync.
function stripSparqlPrologue(query: string): string {
  const lines = query.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const prologueLine = /^\s*(?:prefix\s+\w*:\s*<[^>]*>|base\s+<[^>]*>)\s*\.?\s*$/i;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('#') || prologueLine.test(lines[i])) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

function exNamespaceFor(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}/.well-known/sparql-examples/`;
  } catch {
    return 'https://koetai.github.io/sparql-examples/';
  }
}

function escapeTtl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sanitizeSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

async function handleCuratorReject(
  req: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const curator = await requireCurator(req, env);
  const body = (await req.json()) as { issueNumber?: number; reason?: string };
  if (!body.issueNumber) {
    return text('Missing issueNumber', 400, cors);
  }
  const reason = (body.reason ?? '').trim();
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const octokit = buildOctokit(env);

  const commentLines = [
    `Closed as **won't fix** by curator [${curator.name}](https://orcid.org/${curator.orcid}) via sparql-desktop.`,
  ];
  if (reason) {
    commentLines.push('', '> ' + reason.split('\n').join('\n> '));
  }
  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: body.issueNumber,
      body: commentLines.join('\n'),
    });
  } catch (e) {
    return text(
      `Could not comment on issue: ${(e as Error).message}`,
      502,
      cors,
    );
  }

  // Best-effort: add 'wontfix' label. Ignore failure (label may not exist).
  try {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: body.issueNumber,
      labels: ['wontfix'],
    });
  } catch {
    /* non-fatal */
  }

  try {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: body.issueNumber,
      state: 'closed',
      state_reason: 'not_planned',
    });
  } catch (e) {
    return text(
      `Could not close issue: ${(e as Error).message}`,
      502,
      cors,
    );
  }

  return json({ ok: true, issueNumber: body.issueNumber }, cors);
}
