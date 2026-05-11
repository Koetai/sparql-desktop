// ORCID OAuth 2.0 Authorization Code Flow with PKCE (public client, no secret).
//
// Flow:
//   1. startLogin() — generate verifier+challenge, redirect to ORCID.
//   2. ORCID redirects back with ?code=...&state=...
//   3. completeLogin() — exchange code+verifier for access token, store session.
//   4. getSession() / logout() — manage local session state.

const ORCID_BASE = import.meta.env.VITE_ORCID_BASE_URL ?? 'https://orcid.org';
const CLIENT_ID = import.meta.env.VITE_ORCID_CLIENT_ID as string;
const SCOPE = '/authenticate';
const STORAGE_KEY = 'sparql_desktop_orcid_session';
const VERIFIER_KEY = 'sparql_desktop_pkce_verifier';
const STATE_KEY = 'sparql_desktop_pkce_state';

export interface OrcidSession {
  orcid: string;
  name: string;
  accessToken: string;
  expiresAt: number;
}

function redirectUri(): string {
  return window.location.origin + window.location.pathname;
}

function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

export async function startLogin(): Promise<void> {
  if (!CLIENT_ID) throw new Error('VITE_ORCID_CLIENT_ID is not set');
  const verifier = randomString();
  const challenge = base64url(await sha256(verifier));
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL(`${ORCID_BASE}/oauth/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  window.location.assign(url.toString());
}

export async function completeLoginFromCallback(): Promise<OrcidSession | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return null;

  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!savedState || state !== savedState) throw new Error('OAuth state mismatch');
  if (!verifier) throw new Error('Missing PKCE verifier — restart login');

  const res = await fetch(`${ORCID_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORCID token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    orcid: string;
    name?: string;
  };

  const session: OrcidSession = {
    orcid: data.orcid,
    name: data.name ?? 'ORCID user',
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  window.history.replaceState({}, '', window.location.pathname);
  return session;
}

export function getSession(): OrcidSession | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as OrcidSession;
    if (s.expiresAt < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function logout(): void {
  localStorage.removeItem(STORAGE_KEY);
}
