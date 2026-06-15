// Client-side mirror of the Worker's Turtle generator so the curator UI can
// show a live preview before publish. Keep in sync with worker/src/index.ts.

export function generateTurtle(input: {
  endpoint: string;
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
  // Keep inline PREFIX declarations: each example is fully self-describing.
  // We deliberately do NOT emit `sh:prefixes _:sparql_examples_prefixes` —
  // the multi-endpoint set we curate (UniProt, IDR, QLever Wikidata, etc.)
  // uses too many domain-specific prefixes for a single shared list to cover
  // them all, and `sh:prefixes` would cause "Multiple prefix declarations"
  // errors against any prefix that happens to be in both places.
  const query = input.query.replace(/\r\n/g, '\n').trim();

  return `@prefix ex: <${exBase}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema: <https://schema.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

ex:${input.slug} a sh:SPARQLExecutable,
        sh:SPARQLSelectExecutable ;
    rdfs:label "${labelTtl}" ;
    rdfs:comment "${commentTtl}"^^rdf:HTML ;
    sh:select """${query}""" ;
    schema:keywords ${keywords} ;
    schema:target <${input.endpoint}> .
`;
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
