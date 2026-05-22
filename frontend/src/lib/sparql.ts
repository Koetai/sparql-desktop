// Execute a SPARQL query against an endpoint from the browser.
// Returns row count for SELECT, or 1/0 for ASK. Throws on parse / network errors.
//
// Strategy: try a direct browser → endpoint request first. If that fails with
// a *fetch-level* error (TypeError) — which is what the browser throws for
// mixed-content (http:// endpoints on our https origin) and CORS rejections —
// retry through the Worker's SPARQL proxy, provided we have an ORCID token to
// authenticate it. HTTP error responses (4xx/5xx) are NOT retried, since they
// mean we reached the endpoint and it answered.

import { WORKER_URL } from './api';

export interface QueryResult {
  rowCount: number;
  sample: Record<string, string>[]; // first few rows for preview
  vars: string[];
  durationMs: number;
  viaProxy?: boolean;
}

export async function runQuery(
  endpoint: string,
  query: string,
  accessToken?: string,
): Promise<QueryResult> {
  try {
    return await runDirect(endpoint, query);
  } catch (e) {
    // TypeError from fetch = CORS / mixed-content / DNS / offline. Those are
    // the cases the proxy can rescue. Anything else (e.g. an HTTP error we
    // already parsed) propagates as-is.
    if (e instanceof TypeError && accessToken) {
      return await runViaProxy(endpoint, query, accessToken);
    }
    throw e;
  }
}

async function runDirect(endpoint: string, query: string): Promise<QueryResult> {
  const started = performance.now();
  const url = new URL(endpoint);
  url.searchParams.set('query', query);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Endpoint returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return parseResults((await res.json()) as SparqlResultsJson, started, false);
}

async function runViaProxy(
  endpoint: string,
  query: string,
  accessToken: string,
): Promise<QueryResult> {
  const started = performance.now();
  const res = await fetch(`${WORKER_URL}/api/sparql-proxy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ endpoint, query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Endpoint (via proxy) returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return parseResults((await res.json()) as SparqlResultsJson, started, true);
}

function parseResults(
  json: SparqlResultsJson,
  started: number,
  viaProxy: boolean,
): QueryResult {
  const durationMs = Math.round(performance.now() - started);
  if ('boolean' in json) {
    return { rowCount: json.boolean ? 1 : 0, sample: [], vars: [], durationMs, viaProxy };
  }
  const vars = json.head?.vars ?? [];
  const bindings = json.results?.bindings ?? [];
  const sample = bindings.slice(0, 5).map((row) => {
    const flat: Record<string, string> = {};
    for (const v of vars) flat[v] = row[v]?.value ?? '';
    return flat;
  });
  return { rowCount: bindings.length, sample, vars, durationMs, viaProxy };
}

interface SparqlResultsJson {
  head?: { vars: string[] };
  boolean?: boolean;
  results?: { bindings: Array<Record<string, { value: string; type: string }>> };
}

// Extract PREFIX declarations from a SPARQL query with a tolerant regex.
// Replace with sparqljs-based extraction once that's wired up.
export function extractPrefixes(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /PREFIX\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*<([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}
