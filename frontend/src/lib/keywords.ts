import { Parser } from 'sparqljs';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Extract keyword candidates from a SPARQL query by walking its AST.
// Captures:
//  - the local name of every predicate IRI (e.g., `up:encodedBy` → `encodedBy`)
//  - the local name of every class IRI used in `?s a <Class>` patterns
//  - the prefix labels declared in PREFIX statements (e.g., `up`, `rdfs`)
//
// Returns deduped lowercase-deduped suggestions. The original casing is kept
// when possible so the user sees `encodedBy` instead of `encodedby`.
export function extractKeywordCandidates(query: string): string[] {
  if (!query.trim()) return [];
  let parsed: unknown;
  try {
    parsed = new Parser().parse(query);
  } catch {
    return [];
  }

  const candidates = new Set<string>();
  const seenLower = new Set<string>();
  const add = (raw: string) => {
    const clean = raw.trim();
    if (!clean || clean.length < 2 || clean.length > 40) return;
    const lower = clean.toLowerCase();
    if (seenLower.has(lower)) return;
    seenLower.add(lower);
    candidates.add(clean);
  };

  // Prefix labels (skip the universal ones)
  const SKIP_PREFIXES = new Set(['rdf', 'rdfs', 'xsd', 'owl']);
  const prefixes = (parsed as { prefixes?: Record<string, string> }).prefixes;
  if (prefixes) {
    for (const label of Object.keys(prefixes)) {
      if (!SKIP_PREFIXES.has(label.toLowerCase())) add(label);
    }
  }

  walk(parsed, add);
  return Array.from(candidates);
}

function walk(node: unknown, add: (s: string) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, add);
    return;
  }
  const obj = node as Record<string, unknown>;

  const predicate = obj['predicate'];
  const object = obj['object'];
  if (predicate !== undefined && object !== undefined) {
    const predIri = iriOf(predicate);
    if (predIri && predIri !== RDF_TYPE) {
      const local = lastSegment(predIri);
      if (local) add(local);
    }
    if (predIri === RDF_TYPE) {
      const cls = iriOf(object);
      const local = cls ? lastSegment(cls) : undefined;
      if (local) add(local);
    }
  }

  for (const key of Object.keys(obj)) {
    if (key === 'predicate' || key === 'object' || key === 'subject') continue;
    walk(obj[key], add);
  }
}

function iriOf(term: unknown): string | undefined {
  if (typeof term === 'string') return term.startsWith('?') ? undefined : term;
  if (term && typeof term === 'object') {
    const t = term as { termType?: string; value?: string };
    if (t.termType === 'NamedNode' && t.value) return t.value;
  }
  return undefined;
}

function lastSegment(iri: string): string | undefined {
  const m = iri.match(/[/#]([A-Za-z][A-Za-z0-9_-]*)$/);
  return m?.[1];
}
