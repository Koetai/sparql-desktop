import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface Env {
  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
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
}

interface OrcidIdentity {
  orcid: string;
  name: string;
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
    body: renderIssueBody(body, identity),
    labels,
  });

  return json({ url: issue.data.html_url, number: issue.data.number }, cors);
}

function renderIssueBody(body: SubmissionBody, identity: OrcidIdentity): string {
  const lines: string[] = [
    '## Contributor',
    `**ORCID iD:** [${identity.orcid}](https://orcid.org/${identity.orcid})`,
    `**Name:** ${identity.name}`,
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
  ];

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

interface YummyDataRecord {
  id: number;
  name: string;
  endpoint_url: string;
  score?: number;
  alive?: boolean;
  service_description?: boolean;
  rank?: string;
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
