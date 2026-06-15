// Thin client for the Cloudflare Worker.

export const WORKER_URL =
  import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

export interface SubmissionPayload {
  // 'working' (default) = the contributor has a tested query.
  // 'request' = NL-driven request for an expert to write or fix the query.
  mode?: 'working' | 'request';
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
  // `null` or undefined = no affiliation chosen yet (blocks submit);
  // '__none__' = explicit "None of these";
  // any other string = stable id of a fetched ORCID affiliation.
  selectedAffiliationId?: string | null;
}

export const AFFILIATION_NONE = '__none__';

export interface AffiliationInfo {
  id: string;
  current: boolean;
  name: string;
  rorUrl?: string;
  gridId?: string;
  ringgoldId?: string;
  source?: string;
  role?: string;
  department?: string;
  startYear?: number;
  endYear?: number;
}

export interface AffiliationsResult {
  orcid: string;
  current: AffiliationInfo[];
  past: AffiliationInfo[];
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
// ---------------- Curator API ----------------

export interface CuratorMe {
  orcid: string | null;
  name: string | null;
  isCurator: boolean;
}

export interface IssueSummary {
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  submitter: string | null;
}

export interface ParsedIssue {
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
  contributorOrcid?: string;
  contributorName?: string;
  affiliation?: string;
  endpoint?: string;
  description?: string;
  query?: string;
  keywords: string[];
  aiModel?: string;
  naturalLanguageDescription?: string;
  originalAiQuery?: string;
  rawBody: string;
}

export interface PublishPayload {
  issueNumber: number;
  folder: string;
  slug: string;
  label: string;
  comment: string;
  endpoint: string;
  query: string;
  keywords: string[];
  sequenceNumber?: number;
}

export interface PublishResult {
  prUrl: string;
  prNumber: number;
  path: string;
}

export async function fetchCuratorMe(
  accessToken: string,
): Promise<CuratorMe | null> {
  try {
    const res = await fetch(`${WORKER_URL}/api/curator/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as CuratorMe;
  } catch {
    return null;
  }
}

export async function fetchCuratorIssues(
  accessToken: string,
  opts: { state?: 'open' | 'closed' | 'all'; label?: string } = {},
): Promise<IssueSummary[]> {
  const url = new URL(`${WORKER_URL}/api/curator/issues`);
  if (opts.state) url.searchParams.set('state', opts.state);
  if (opts.label) url.searchParams.set('label', opts.label);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to load issues (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { issues: IssueSummary[] };
  return data.issues;
}

export async function fetchCuratorIssue(
  accessToken: string,
  number: number,
): Promise<ParsedIssue> {
  const res = await fetch(`${WORKER_URL}/api/curator/issues/${number}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to load issue #${number}: ${await res.text()}`);
  return (await res.json()) as ParsedIssue;
}

export async function fetchCuratorFolders(
  accessToken: string,
): Promise<string[]> {
  const res = await fetch(`${WORKER_URL}/api/curator/folders`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { folders: string[] };
  return data.folders;
}

export async function publishCuratedExample(
  accessToken: string,
  payload: PublishPayload,
): Promise<PublishResult> {
  const res = await fetch(`${WORKER_URL}/api/curator/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Publish failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as PublishResult;
}

// ---------------- Affiliations ----------------

export async function fetchAffiliations(
  accessToken: string,
): Promise<AffiliationsResult | null> {
  try {
    const res = await fetch(`${WORKER_URL}/api/affiliations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AffiliationsResult;
  } catch {
    return null;
  }
}

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
