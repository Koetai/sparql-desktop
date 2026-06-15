import { useEffect, useMemo, useState } from 'react';
import {
  fetchCuratorFolders,
  fetchCuratorIssue,
  fetchCuratorIssues,
  publishCuratedExample,
  rejectIssue,
  type IssueSummary,
  type ParsedIssue,
} from '../lib/api';
import type { OrcidSession } from '../auth/orcid';
import { YasqeEditor } from './YasqeEditor';
import { generateTurtle, sanitizeSlug, suggestFolder } from '../lib/turtle';

interface Props {
  session: OrcidSession;
}

type LabelFilter = 'ready-to-merge' | 'needs-expert' | '';

export function Curator({ session }: Props) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [filter, setFilter] = useState<LabelFilter>('ready-to-merge');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  async function refreshList() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchCuratorIssues(session.accessToken, {
        state: 'open',
        label: filter || undefined,
      });
      setIssues(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  if (selectedNumber !== null) {
    return (
      <CuratorDetail
        session={session}
        issueNumber={selectedNumber}
        onBack={() => {
          setSelectedNumber(null);
          refreshList();
        }}
      />
    );
  }

  return (
    <div className="curator">
      <div className="curator-controls">
        <label>
          Filter:&nbsp;
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as LabelFilter)}
          >
            <option value="ready-to-merge">ready-to-merge</option>
            <option value="needs-expert">needs-expert</option>
            <option value="">all open</option>
          </select>
        </label>
        <button className="secondary" type="button" onClick={refreshList} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {!loading && issues.length === 0 && (
        <p className="placeholder">No open issues match this filter.</p>
      )}

      <ul className="issue-list">
        {issues.map((i) => (
          <li key={i.number}>
            <button
              type="button"
              className="issue-card"
              onClick={() => setSelectedNumber(i.number)}
            >
              <div className="issue-card-title">
                <span className="issue-number">#{i.number}</span>{' '}
                <span className="issue-title-text">{i.title}</span>
              </div>
              <div className="issue-card-meta">
                {i.labels.map((l) => (
                  <span key={l} className={`label label-${l}`}>{l}</span>
                ))}
                <span className="muted">
                  · opened {new Date(i.createdAt).toISOString().slice(0, 10)} by {i.submitter ?? 'unknown'}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface DetailProps {
  session: OrcidSession;
  issueNumber: number;
  onBack: () => void;
}

function CuratorDetail({ session, issueNumber, onBack }: DetailProps) {
  const [issue, setIssue] = useState<ParsedIssue | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable fields, pre-populated from the issue once loaded
  const [folder, setFolder] = useState('');
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [query, setQuery] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [sequenceNumber, setSequenceNumber] = useState<number | ''>('');

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{
    prUrl: string;
    prNumber: number;
    path: string;
  } | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [parsed, folderList] = await Promise.all([
          fetchCuratorIssue(session.accessToken, issueNumber),
          fetchCuratorFolders(session.accessToken),
        ]);
        if (cancelled) return;
        setIssue(parsed);
        setFolders(folderList);
        setLabel(parsed.title);
        setComment(parsed.description ?? '');
        setEndpoint(parsed.endpoint ?? '');
        setQuery(parsed.query ?? '');
        setKeywordsText(parsed.keywords.join(', '));
        setSlug(sanitizeSlug(parsed.title));
        setFolder(suggestFolder(parsed.endpoint ?? '', folderList));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [issueNumber, session.accessToken]);

  const keywords = useMemo(
    () =>
      keywordsText
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    [keywordsText],
  );

  const turtle = useMemo(() => {
    if (!slug || !label || !query || !endpoint) return '';
    return generateTurtle({
      endpoint: endpoint.trim(),
      slug: sanitizeSlug(slug),
      label,
      comment,
      query,
      keywords,
    });
  }, [slug, label, comment, query, endpoint, keywords]);

  const canPublish =
    !!issue &&
    !!folder.trim() &&
    !!slug.trim() &&
    !!label.trim() &&
    !!endpoint.trim() &&
    !!query.trim() &&
    !publishing;

  async function handleReject() {
    if (!issue) return;
    setRejecting(true);
    setRejectError(null);
    try {
      await rejectIssue(session.accessToken, issue.number, rejectReason.trim());
      setRejected(true);
    } catch (e) {
      setRejectError((e as Error).message);
    } finally {
      setRejecting(false);
    }
  }

  async function handlePublish() {
    if (!issue) return;
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    try {
      const result = await publishCuratedExample(session.accessToken, {
        issueNumber: issue.number,
        folder: folder.trim(),
        slug: sanitizeSlug(slug),
        label: label.trim(),
        comment: comment.trim(),
        endpoint: endpoint.trim(),
        query,
        keywords,
        sequenceNumber: typeof sequenceNumber === 'number' ? sequenceNumber : undefined,
      });
      setPublishResult(result);
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return <div className="curator">Loading issue #{issueNumber}…</div>;
  if (error) {
    return (
      <div className="curator">
        <button type="button" className="secondary" onClick={onBack}>← Back to list</button>
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!issue) return null;

  if (publishResult) {
    return (
      <div className="curator">
        <button type="button" className="secondary" onClick={onBack}>← Back to list</button>
        <div className="success">
          <h2>Published</h2>
          <p>
            PR <a href={publishResult.prUrl} target="_blank" rel="noreferrer">#{publishResult.prNumber}</a> opened on
            koetai/sparql-examples. It will auto-close issue #{issue.number} when merged.
          </p>
          <p>File: <code>{publishResult.path}</code></p>
        </div>
      </div>
    );
  }

  if (rejected) {
    return (
      <div className="curator">
        <button type="button" className="secondary" onClick={onBack}>← Back to list</button>
        <div className="success">
          <h2>Closed as won't fix</h2>
          <p>
            Issue <a href={issue.htmlUrl} target="_blank" rel="noreferrer">#{issue.number}</a> closed
            with the <code>wontfix</code> label.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="curator">
      <button type="button" className="secondary" onClick={onBack}>← Back to list</button>

      <h2>
        Issue #{issue.number}: {issue.title}
      </h2>
      <p className="hint">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">View original issue on GitHub</a>
      </p>

      <div className="contributor-box">
        {issue.contributorOrcid && (
          <div>
            <strong>Contributor:</strong>{' '}
            {issue.contributorName ?? 'Unknown'} ·{' '}
            <a
              href={`https://orcid.org/${issue.contributorOrcid}`}
              target="_blank"
              rel="noreferrer"
            >
              {issue.contributorOrcid}
            </a>
          </div>
        )}
        {issue.affiliation && (
          <div>
            <strong>Affiliation:</strong> {issue.affiliation}
          </div>
        )}
        {issue.aiModel && (
          <div>
            <strong>LLM used:</strong> {issue.aiModel}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="curate-label">Label (rdfs:label)</label>
        <input
          id="curate-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="curate-comment">Comment (rdfs:comment)</label>
        <textarea
          id="curate-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="Description shown in the SPARQL examples site. HTML allowed."
        />
      </div>

      <div className="field">
        <label htmlFor="curate-endpoint">Target endpoint</label>
        <input
          id="curate-endpoint"
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          required
        />
      </div>

      <div className="curate-row">
        <div className="field">
          <label htmlFor="curate-folder">Folder (under examples/)</label>
          <input
            id="curate-folder"
            type="text"
            list="curate-folder-options"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="UniProt"
            required
          />
          <datalist id="curate-folder-options">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <p className="hint">{folders.length} existing folders. Type a new name to create one.</p>
        </div>

        <div className="field">
          <label htmlFor="curate-slug">Slug (file name)</label>
          <input
            id="curate-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="list_proteins"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="curate-sequence">Sequence # (optional)</label>
          <input
            id="curate-sequence"
            type="number"
            min={1}
            value={sequenceNumber}
            onChange={(e) =>
              setSequenceNumber(e.target.value ? Number(e.target.value) : '')
            }
            placeholder="100"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="curate-keywords">Keywords</label>
        <input
          id="curate-keywords"
          type="text"
          value={keywordsText}
          onChange={(e) => setKeywordsText(e.target.value)}
          placeholder="comma-separated"
        />
      </div>

      <div className="field">
        <label>SPARQL query</label>
        <YasqeEditor
          defaultQuery={query}
          endpoint={endpoint}
          onChange={setQuery}
        />
      </div>

      <details className="result-preview" open>
        <summary>Turtle preview</summary>
        <pre className="turtle-preview">{turtle || '_(fill the fields above to see the generated Turtle)_'}</pre>
      </details>

      {publishError && <div className="error">{publishError}</div>}
      {rejectError && <div className="error">{rejectError}</div>}

      <div className="submit-row">
        <button
          type="button"
          className="primary"
          disabled={!canPublish}
          onClick={handlePublish}
        >
          {publishing ? 'Opening PR…' : `Publish PR to koetai/sparql-examples`}
        </button>
        {!canPublish && !publishing && (
          <p className="hint">Fill folder, slug, label, endpoint, and query to publish.</p>
        )}
        <button
          type="button"
          className="danger"
          onClick={() => setRejectOpen((v) => !v)}
          disabled={publishing || rejecting}
        >
          Close as 'won't fix'
        </button>
      </div>

      {rejectOpen && (
        <div className="reject-panel">
          <label htmlFor="curate-reject-reason">
            Reason (optional, posted as a comment on the issue)
          </label>
          <textarea
            id="curate-reject-reason"
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. duplicate of #N, off-topic, query unrecoverable"
          />
          <div className="reject-actions">
            <button
              type="button"
              className="danger"
              disabled={rejecting}
              onClick={handleReject}
            >
              {rejecting ? 'Closing…' : `Confirm: close #${issue.number} as won't fix`}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setRejectOpen(false)}
              disabled={rejecting}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
