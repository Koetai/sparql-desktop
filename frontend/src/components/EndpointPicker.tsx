import { useEffect, useState } from 'react';
import { fetchEndpoints, type EndpointInfo } from '../lib/api';
import { CURATED_ENDPOINTS, FALLBACK_ENDPOINTS } from '../lib/endpoints';

interface Props {
  value: string;
  onChange: (url: string) => void;
  inputId?: string;
}

// Merge curated endpoints (always shown, listed first) with a base list,
// de-duplicating by URL. Curated entries win on name collisions.
function withCurated(base: EndpointInfo[]): EndpointInfo[] {
  const seen = new Set<string>();
  const out: EndpointInfo[] = [];
  for (const e of [...CURATED_ENDPOINTS, ...base]) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
}

// A native <input list> + <datalist> typeahead. The user can either pick a
// known endpoint by name or paste a raw URL — both produce the same shape
// (the URL is what we submit). The curated endpoints are always present;
// when the worker is unreachable we fall back to a small static list.
export function EndpointPicker({ value, onChange, inputId = 'endpoint' }: Props) {
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>(
    withCurated(FALLBACK_ENDPOINTS),
  );
  const [source, setSource] = useState<'worker' | 'fallback'>('fallback');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromWorker = await fetchEndpoints();
      if (cancelled) return;
      if (fromWorker && fromWorker.length > 0) {
        setEndpoints(withCurated(fromWorker));
        setSource('worker');
      } else {
        setEndpoints(withCurated(FALLBACK_ENDPOINTS));
        setSource('fallback');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const matchedName = endpoints.find((e) => e.url === value)?.name;

  return (
    <>
      <input
        id={inputId}
        type="url"
        list="endpoint-options"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // If the user typed a name that matches an endpoint, swap to its URL.
          const match = endpoints.find((ep) => ep.name === next);
          onChange(match ? match.url : next);
        }}
        placeholder="https://sparql.example.org/sparql or pick from the list"
        required
      />
      <datalist id="endpoint-options">
        {endpoints.map((ep) => (
          <option key={ep.url} value={ep.url}>
            {ep.name}
            {ep.rank ? ` — rank ${ep.rank}` : ''}
          </option>
        ))}
      </datalist>
      <p className="hint">
        {loading
          ? 'Loading endpoints…'
          : source === 'worker'
            ? `${endpoints.length} endpoints from YummyData${matchedName ? ` — selected: ${matchedName}` : ''}`
            : `Worker offline — showing ${endpoints.length} curated endpoints${matchedName ? ` (selected: ${matchedName})` : ''}. Paste any URL to use a different endpoint.`}
      </p>
    </>
  );
}
