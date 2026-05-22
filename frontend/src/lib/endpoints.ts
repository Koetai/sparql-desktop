import type { EndpointInfo } from './api';

// Curated endpoints that are ALWAYS shown, merged on top of whatever the
// Worker/YummyData returns. Use this for institutional or special endpoints
// that aren't in the YummyData catalog. Endpoints that are http-only or lack
// CORS still work — runQuery transparently falls back to the Worker proxy.
export const CURATED_ENDPOINTS: EndpointInfo[] = [
  { name: 'Wikidata (QLever)', url: 'https://qlever.dev/api/wikidata' },
  // IDR (OMERO) QLever mirror. HTTP-only, so queries route through the Worker
  // proxy. The /qlever/sparql/ path is the SPARQL API; /qlever/idr is the UI.
  { name: 'IDR Münster (QLever)', url: 'http://idr-sparql.uni-muenster.de/qlever/sparql/' },
];

// Static fallback list used when the Worker isn't reachable (dev mode without
// `wrangler dev`, or before deployment). A small curated set covering the
// kinds of life-science endpoints upstream YummyData tracks.
export const FALLBACK_ENDPOINTS: EndpointInfo[] = [
  { name: 'UniProt', url: 'https://sparql.uniprot.org/sparql' },
  { name: 'Wikidata', url: 'https://query.wikidata.org/sparql' },
  { name: 'Bgee', url: 'https://www.bgee.org/sparql/' },
  { name: 'OMA', url: 'https://sparql.omabrowser.org/sparql/' },
  { name: 'Rhea', url: 'https://sparql.rhea-db.org/sparql/' },
  { name: 'OrthoDB', url: 'https://sparql.orthodb.org/sparql/' },
  { name: 'neXtProt', url: 'https://sparql.nextprot.org/' },
  { name: 'IDSM/Sachem', url: 'https://idsm.elixir-czech.cz/sparql/endpoint/idsm' },
  { name: 'DBpedia', url: 'https://dbpedia.org/sparql' },
  { name: 'EBI RDF Platform', url: 'https://www.ebi.ac.uk/rdf/services/sparql' },
];
