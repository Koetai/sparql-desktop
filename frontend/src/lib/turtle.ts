// Client-side mirror of the Worker's Turtle generator so the curator UI can
// show a live preview before publish. Keep in sync with worker/src/index.ts.

export function generateTurtle(input: {
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
  // de-duplicate them in the prologue. LLM-generated queries sometimes carry
  // two stacked PREFIX blocks; RDF4J rejects duplicate declarations with
  // "Multiple prefix declarations" even when the URIs match.
  const query = dedupeSparqlPrologue(input.query);

  // The upstream SHACL test `testAllServicesAnnotated` requires every
  // `SERVICE <IRI>` in the query to be reflected as `spex:federatesWith <IRI>`
  // on the example resource.
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

// Extracts the distinct full IRIs referenced by `SERVICE <IRI>` in a SPARQL
// query. Variable-based SERVICE (e.g. `SERVICE ?endpoint`) is skipped — the
// upstream SHACL test only requires annotations for static endpoints.
export function extractServiceIris(query: string): string[] {
  const re = /\bSERVICE\s+(?:SILENT\s+)?<([^>]+)>/gi;
  const out = new Set<string>();
  for (const m of query.matchAll(re)) out.add(m[1]);
  return [...out];
}

export function sanitizeSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

// Auto-suggest an existing folder name based on the endpoint host.
export function suggestFolder(endpoint: string, existing: string[]): string {
  try {
    const u = new URL(endpoint);
    const host = u.host.toLowerCase();
    // Try direct host-keyword match (e.g., "uniprot" matches "UniProt")
    const tokens = host.replace(/^(www|sparql)\./, '').split(/[.-]/);
    for (const t of tokens) {
      if (!t || t === 'org' || t === 'com' || t === 'net') continue;
      const hit = existing.find((f) => f.toLowerCase() === t.toLowerCase());
      if (hit) return hit;
      const partial = existing.find((f) =>
        f.toLowerCase().includes(t.toLowerCase()),
      );
      if (partial) return partial;
    }
    // Fall back to a kebab-case folder derived from the host
    return host.replace(/[^a-z0-9.-]/g, '');
  } catch {
    return '';
  }
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

// De-duplicates PREFIX declarations in the SPARQL prologue, keeping the
// first occurrence of each prefix name. Walks line-by-line until the first
// non-prologue / non-blank / non-comment line, then emits the body verbatim.
// LLM-generated queries frequently include two stacked prefix blocks; the
// RDF4J parser rejects duplicates even when they map to identical URIs.
export function dedupeSparqlPrologue(query: string): string {
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

// Drops the SPARQL prologue (PREFIX / BASE lines) from the top of a query.
// The grammar requires the prologue to come first, so we walk from the top
// skipping blanks, comments, and prologue lines; once we hit a non-prologue
// non-blank non-comment line, the rest is the body.
export function stripSparqlPrologue(query: string): string {
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
