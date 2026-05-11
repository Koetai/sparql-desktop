// Execute a SPARQL query against an endpoint from the browser.
// Returns row count for SELECT, or 1/0 for ASK. Throws on parse / network errors.
// CORS is the responsibility of the endpoint; endpoints without permissive
// CORS will need a Worker proxy (TODO).

export interface QueryResult {
  rowCount: number;
  sample: Record<string, string>[]; // first few rows for preview
  vars: string[];
  durationMs: number;
}

export async function runQuery(endpoint: string, query: string): Promise<QueryResult> {
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

  const json = (await res.json()) as SparqlResultsJson;
  const durationMs = Math.round(performance.now() - started);

  if ('boolean' in json) {
    return { rowCount: json.boolean ? 1 : 0, sample: [], vars: [], durationMs };
  }

  const vars = json.head?.vars ?? [];
  const bindings = json.results?.bindings ?? [];
  const sample = bindings.slice(0, 5).map((row) => {
    const flat: Record<string, string> = {};
    for (const v of vars) flat[v] = row[v]?.value ?? '';
    return flat;
  });
  return { rowCount: bindings.length, sample, vars, durationMs };
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
