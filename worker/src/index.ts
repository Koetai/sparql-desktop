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
  // KV
  RATE_LIMITS: KVNamespace;
}

interface SubmissionBody {
  title: string;
  description: string;
  endpoint: string;
  query: string;
  keywords: string[];
  prefixes: Record<string, string>;
  aiSuggested?: boolean;
  aiModel?: string;
  naturalLanguageDescription?: string;
  originalAiQuery?: string;
  // Sentinel value for "None of these" — the user explicitly opted out.
  // Any other non-empty value must match an id from /api/affiliations for
  // this user; otherwise the Worker rejects the submission.
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
      if (url.pathname === '/api/submit' && req.method === 'POST') {
        return await handleSubmit(req, env, cors);
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
  if (!body.query || !body.endpoint || !body.title) {
    return text('Missing required fields: title, endpoint, query', 400, cors);
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

  const labels = ['ready-to-merge'];
  if (body.aiSuggested) labels.push('ai-assisted');

  const issue = await octokit.issues.create({
    owner,
    repo,
    title: body.title,
    body: renderIssueBody(body, identity, selectedAffiliation),
    labels,
  });

  return json({ url: issue.data.html_url, number: issue.data.number }, cors);
}

function renderIssueBody(
  body: SubmissionBody,
  identity: OrcidIdentity,
  affiliation: Affiliation | null,
): string {
  const lines: string[] = [
    '## Contributor',
    `**ORCID iD:** [${identity.orcid}](https://orcid.org/${identity.orcid})`,
    `**Name:** ${identity.name}`,
  ];

  if (affiliation) {
    lines.push('', '### Affiliation', renderAffiliationLine(affiliation));
  } else {
    lines.push(
      '',
      '### Affiliation',
      '_None selected — contributor either had no relevant affiliation in their ORCID record, or chose not to associate one with this submission._',
    );
  }

  lines.push(
    '',
    '## Endpoint',
    body.endpoint,
    '',
    '## Description',
    body.description || '_(none provided)_',
    '',
    '## Query',
    '```sparql',
    body.query,
    '```',
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

  if (body.aiSuggested) {
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
