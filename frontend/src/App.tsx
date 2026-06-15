import { useEffect, useState } from 'react';
import {
  completeLoginFromCallback,
  getSession,
  logout,
  startLogin,
  type OrcidSession,
} from './auth/orcid';
import { SubmissionForm } from './components/SubmissionForm';
import { Curator } from './components/Curator';
import { fetchCuratorMe } from './lib/api';

type View = 'submit' | 'curate';

export function App() {
  const [session, setSession] = useState<OrcidSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCurator, setIsCurator] = useState(false);
  const [view, setView] = useState<View>('submit');

  useEffect(() => {
    (async () => {
      try {
        const fromCallback = await completeLoginFromCallback();
        setSession(fromCallback ?? getSession());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!session) {
      setIsCurator(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const me = await fetchCuratorMe(session.accessToken);
      if (cancelled) return;
      setIsCurator(!!me?.isCurator);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  function handleLogin() {
    startLogin().catch((e) => setError((e as Error).message));
  }

  // Dev shortcut: only in `vite dev` if no ORCID client is configured, allow a
  // fake session so we can develop the form UI. Never enabled in production.
  const devModeAvailable =
    import.meta.env.DEV && !import.meta.env.VITE_ORCID_CLIENT_ID;

  function handleDevLogin() {
    const fake: OrcidSession = {
      orcid: '0000-0000-0000-0000',
      name: 'Dev User',
      accessToken: 'dev-fake-token',
      expiresAt: Date.now() + 3600 * 1000,
    };
    setSession(fake);
  }

  if (loading) return <div className="app">Loading…</div>;

  return (
    <div className="app">
      <header>
        <h1>
          SPARQL desktop
          <span className="subtitle">koetai/sparql-examples</span>
        </h1>
        {session ? (
          <div className="session">
            {isCurator && (
              <div className="view-toggle">
                <button
                  type="button"
                  className={view === 'submit' ? 'tab tab-active' : 'tab'}
                  onClick={() => setView('submit')}
                >
                  Submit
                </button>
                <button
                  type="button"
                  className={view === 'curate' ? 'tab tab-active' : 'tab'}
                  onClick={() => setView('curate')}
                >
                  Curate
                </button>
              </div>
            )}
            <span>
              Signed in as <strong>{session.name}</strong>{' '}
              <span className="orcid-id">{session.orcid}</span>
            </span>
            <button
              className="secondary"
              onClick={() => {
                logout();
                setSession(null);
                setView('submit');
              }}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="login-actions">
            <button className="orcid" onClick={handleLogin}>
              Sign in with ORCID
            </button>
            {devModeAvailable && (
              <button
                className="secondary dev-login"
                onClick={handleDevLogin}
                title="No ORCID client configured. Using a fake session for development."
              >
                Dev login
              </button>
            )}
          </div>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      {session ? (
        isCurator && view === 'curate' ? (
          <Curator session={session} />
        ) : (
          <SubmissionForm session={session} />
        )
      ) : (
        <div className="placeholder">
          <h2>Contribute SPARQL examples to koetai/sparql-examples</h2>
          <p>
            Sign in with your ORCID iD to write or refine a SPARQL query and
            submit it for inclusion in the examples repository. No GitHub
            account required.
          </p>
        </div>
      )}
    </div>
  );
}
