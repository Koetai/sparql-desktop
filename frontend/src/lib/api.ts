// Thin client for the Cloudflare Worker.

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

export interface SubmissionPayload {
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

export interface SubmissionResult {
  url: string;
}

export async function submitQuery(
  accessToken: string,
  payload: SubmissionPayload,
): Promise<SubmissionResult> {
  const res = await fetch(`${WORKER_URL}/api/submit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Submission failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<SubmissionResult>;
}

export interface EndpointInfo {
  name: string;
  url: string;
  rank?: string | null;
  score?: number | null;
}

export interface EndpointsResult {
  endpoints: EndpointInfo[];
  source: 'worker' | 'fallback';
}

// Attempts the Worker first; on any failure (network, non-2xx, parse) returns
// `null` so the caller can fall back to a static list. We never throw — the
// picker should always have *something* to show.
export async function fetchEndpoints(): Promise<EndpointInfo[] | null> {
  try {
    const res = await fetch(`${WORKER_URL}/api/yummydata`);
    if (!res.ok) return null;
    const data = (await res.json()) as { endpoints?: EndpointInfo[] };
    return Array.isArray(data.endpoints) ? data.endpoints : null;
  } catch {
    return null;
  }
}
