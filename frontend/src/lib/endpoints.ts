import type { EndpointInfo } from './api';

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
