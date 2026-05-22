import { useMemo, useState } from 'react';
import { extractPrefixes, runQuery, type QueryResult } from '../lib/sparql';
import { submitQuery } from '../lib/api';
import type { OrcidSession } from '../auth/orcid';
import { YasqeEditor } from './YasqeEditor';
import { EndpointPicker } from './EndpointPicker';
import { AffiliationPicker } from './AffiliationPicker';
import { LlmHelper } from './LlmHelper';
import { extractKeywordCandidates } from '../lib/keywords';

type Mode = 'working' | 'request';

const COMMON_MODELS = [
  'OpenAI GPT-5',
  'OpenAI GPT-4o',
  'Anthropic Claude Opus 4.7',
  'Anthropic Claude Sonnet 4.6',
  'Anthropic Claude Haiku 4.5',
  'Meta Llama 4',
  'Mistral Large',
  'Google Gemini 2.5 Pro',
  'Other',
];

const EXAMPLE_ENDPOINT = 'https://sparql.uniprot.org/sparql';
const EXAMPLE_QUERY = `PREFIX up: <http://purl.uniprot.org/core/>
SELECT ?protein WHERE {
  ?protein a up:Protein .
} LIMIT 5`;

interface Props {
  session: OrcidSession;
}

export function SubmissionForm({ session }: Props) {
  const [mode, setMode] = useState<Mode>('working');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState(EXAMPLE_ENDPOINT);
  const [query, setQuery] = useState(EXAMPLE_QUERY);
  const [keywordsText, setKeywordsText] = useState('');

  const [affiliationId, setAffiliationId] = useState<string>('');

  // AI-related fields are shared between modes:
  //   - working + aiSuggested toggle on  → user wrote/finalized a query that
  //     started from an LLM; model + NL + original-attempt are captured.
  //   - request mode                     → these are required (NL is the
  //     prompt, model is the LLM that was tried; query is the LLM's draft).
  const [aiSuggested, setAiSuggested] = useState(false);
  const [aiModel, setAiModel] = useState(COMMON_MODELS[2]);
  const [aiModelOther, setAiModelOther] = useState('');
  const [naturalLanguageDescription, setNaturalLanguageDescription] = useState('');
  const [originalAiQuery, setOriginalAiQuery] = useState('');

  const [testResult, setTestResult] = useState<QueryResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);

  const keywords = useMemo(
    () =>
      keywordsText
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    [keywordsText],
  );

  const prefixes = useMemo(() => extractPrefixes(query), [query]);

  const suggestedKeywords = useMemo(() => {
    const existing = new Set(keywords.map((k) => k.toLowerCase()));
    return extractKeywordCandidates(query).filter(
      (k) => !existing.has(k.toLowerCase()),
    );
  }, [query, keywords]);

  const baseRequirementsMet =
    !!title.trim() && !!endpoint.trim() && !!affiliationId && !submitting;

  // "Submit as working query" — requires a tested query that returns rows.
  // Active for both modes (in request mode it appears alongside the
  // request-for-help button when the LLM's draft works after testing).
  const canSubmitWorking =
    baseRequirementsMet &&
    !!query.trim() &&
    testResult !== null &&
    testResult.rowCount > 0 &&
    (mode === 'request'
      ? // in request mode we'd promote to working; capture as ai-assisted
        !!naturalLanguageDescription.trim() && resolvedModel().length > 0
      : !aiSuggested ||
        (!!naturalLanguageDescription.trim() && resolvedModel().length > 0));

  // "Submit request for expert help" — only in request mode. Query is
  // optional; NL + model are required so an expert has enough to work with.
  const canSubmitRequest =
    mode === 'request' &&
    baseRequirementsMet &&
    !!naturalLanguageDescription.trim() &&
    resolvedModel().length > 0;

  function resolvedModel(): string {
    return aiModel === 'Other' ? aiModelOther.trim() : aiModel;
  }

  function invalidateTest() {
    setTestResult(null);
    setTestError(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      // Pass the ORCID token so runQuery can fall back to the Worker proxy
      // for http-only or CORS-less endpoints.
      const r = await runQuery(endpoint, query, session.accessToken);
      setTestResult(r);
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  // submitMode controls which kind of issue is created:
  //   'working' — labels ready-to-merge, requires tested query
  //   'request' — labels needs-expert, NL + model required, query optional
  async function handleSubmit(submitMode: Mode) {
    setSubmitting(true);
    setSubmitError(null);
    setSubmittedUrl(null);
    try {
      // `mode` is the SOURCE (how the user filled the form); `submitMode` is
      // the TARGET issue kind. When the form is in request mode, the user's
      // intent lives in `naturalLanguageDescription` — use it as the issue
      // description and always capture AI provenance, even when promoting the
      // LLM draft to a working-query submission.
      const fromRequest = mode === 'request';
      const aiActive = fromRequest || aiSuggested;
      const effectiveDescription = fromRequest
        ? naturalLanguageDescription.trim()
        : description.trim();
      const result = await submitQuery(session.accessToken, {
        mode: submitMode,
        title: title.trim(),
        description: effectiveDescription,
        endpoint: endpoint.trim(),
        query,
        keywords,
        prefixes,
        selectedAffiliationId: affiliationId,
        aiSuggested: aiActive,
        aiModel: aiActive ? resolvedModel() : undefined,
        naturalLanguageDescription: aiActive
          ? naturalLanguageDescription.trim()
          : undefined,
        originalAiQuery:
          aiActive && originalAiQuery.trim() ? originalAiQuery : undefined,
      });
      setSubmittedUrl(result.url);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const aiToggleSection = (
    <fieldset className="ai-section">
      <legend>
        <label>
          <input
            type="checkbox"
            checked={aiSuggested}
            onChange={(e) => setAiSuggested(e.target.checked)}
          />{' '}
          This query was AI-suggested
        </label>
      </legend>

      {aiSuggested && (
        <>
          <div className="field">
            <label htmlFor="ai-model">Model used</label>
            <select
              id="ai-model"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
            >
              {COMMON_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {aiModel === 'Other' && (
              <input
                type="text"
                value={aiModelOther}
                onChange={(e) => setAiModelOther(e.target.value)}
                placeholder="Model name and version"
                className="model-other"
                required
              />
            )}
          </div>

          <div className="field">
            <label htmlFor="nl-description">
              Original natural-language description
            </label>
            <textarea
              id="nl-description"
              value={naturalLanguageDescription}
              onChange={(e) => setNaturalLanguageDescription(e.target.value)}
              placeholder="The question you asked the model"
              rows={2}
              required={aiSuggested}
            />
          </div>

          <div className="field">
            <label htmlFor="original-ai-query">
              Original AI suggestion{' '}
              <span className="hint-inline">(if you edited it)</span>
            </label>
            <textarea
              id="original-ai-query"
              value={originalAiQuery}
              onChange={(e) => setOriginalAiQuery(e.target.value)}
              placeholder="Paste the first query the model produced (optional, for provenance)"
              rows={6}
              spellCheck={false}
              className="mono"
            />
          </div>
        </>
      )}
    </fieldset>
  );

  if (submittedUrl) {
    return (
      <div className="success">
        <h2>Submitted</h2>
        <p>
          Your contribution is filed as a GitHub issue on{' '}
          <code>koetai/sparql-examples</code>.
        </p>
        <p>
          <a href={submittedUrl} target="_blank" rel="noreferrer">
            {submittedUrl}
          </a>
        </p>
        <button
          className="secondary"
          onClick={() => {
            setSubmittedUrl(null);
            setTitle('');
            setDescription('');
            setKeywordsText('');
            setNaturalLanguageDescription('');
            setOriginalAiQuery('');
            setTestResult(null);
          }}
        >
          Submit another
        </button>
      </div>
    );
  }

  return (
    <form
      className="submission-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Default form submit (Enter key) only fires the working path.
        if (canSubmitWorking) handleSubmit('working');
      }}
    >
      <fieldset className="mode-selector">
        <legend>What are you submitting?</legend>
        <label>
          <input
            type="radio"
            name="mode"
            value="working"
            checked={mode === 'working'}
            onChange={() => setMode('working')}
          />
          <span>
            <strong>A working SPARQL query.</strong> I have one I've tested.
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            value="request"
            checked={mode === 'request'}
            onChange={() => setMode('request')}
          />
          <span>
            <strong>A request.</strong> I'll describe what I want, get a draft
            from an LLM, and optionally ask an expert to fix it.
          </span>
        </label>
      </fieldset>

      <div className="field">
        <label htmlFor="title">Title</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short label for this example query"
          required
        />
      </div>

      {mode === 'request' ? (
        <>
          <div className="field">
            <label htmlFor="nl-description-primary">
              Describe what you want the query to do
            </label>
            <textarea
              id="nl-description-primary"
              value={naturalLanguageDescription}
              onChange={(e) => setNaturalLanguageDescription(e.target.value)}
              placeholder="e.g. List all UniProt human proteins that are reviewed and have a known disease association."
              rows={4}
              required
            />
            <p className="hint">
              This becomes both the prompt for the LLM and the description in
              the GitHub issue.
            </p>
          </div>

          <div className="field">
            <label htmlFor="ai-model-request">LLM to use (for capture in the issue)</label>
            <select
              id="ai-model-request"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
            >
              {COMMON_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {aiModel === 'Other' && (
              <input
                type="text"
                value={aiModelOther}
                onChange={(e) => setAiModelOther(e.target.value)}
                placeholder="Model name and version"
                className="model-other"
                required
              />
            )}
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this query do? What question does it answer?"
            rows={3}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="endpoint">SPARQL endpoint</label>
        <EndpointPicker
          value={endpoint}
          onChange={(url) => {
            setEndpoint(url);
            invalidateTest();
          }}
        />
      </div>

      {mode === 'request' && (
        <div className="field">
          <label>Get a draft from an LLM</label>
          <LlmHelper
            endpoint={endpoint}
            naturalLanguageDescription={naturalLanguageDescription}
          />
        </div>
      )}

      <div className="field">
        <label>
          {mode === 'request'
            ? 'Paste the LLM-generated SPARQL here, then test it'
            : 'SPARQL query'}
        </label>
        <YasqeEditor
          defaultQuery={query}
          endpoint={endpoint}
          onChange={(q) => {
            setQuery(q);
            invalidateTest();
          }}
        />
        <div className="field-actions">
          <button
            type="button"
            className="secondary"
            disabled={testing || !endpoint.trim() || !query.trim()}
            onClick={handleTest}
          >
            {testing ? 'Testing…' : 'Test query'}
          </button>
          {testResult && (
            <span className="test-success">
              ✓ {testResult.rowCount} {testResult.rowCount === 1 ? 'row' : 'rows'} in{' '}
              {testResult.durationMs} ms
              {testResult.viaProxy && (
                <span className="proxy-tag" title="This endpoint is HTTP-only or lacks CORS, so the query was routed through the Worker proxy.">
                  {' '}· via proxy
                </span>
              )}
            </span>
          )}
          {testError && <span className="test-error">{testError}</span>}
        </div>
        {testResult && testResult.sample.length > 0 && (
          <details className="result-preview">
            <summary>Preview ({testResult.sample.length} of {testResult.rowCount})</summary>
            <table>
              <thead>
                <tr>
                  {testResult.vars.map((v) => (
                    <th key={v}>?{v}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {testResult.sample.map((row, i) => (
                  <tr key={i}>
                    {testResult.vars.map((v) => (
                      <td key={v}>{row[v]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <div className="field">
        <label htmlFor="keywords">Keywords</label>
        <input
          id="keywords"
          type="text"
          value={keywordsText}
          onChange={(e) => setKeywordsText(e.target.value)}
          placeholder="protein, sequence, uniprot (comma-separated)"
        />
        <p className="hint">
          Comma-separated. The more, the better — they help maintainers
          categorize the example.
        </p>
        {suggestedKeywords.length > 0 && (
          <div className="suggested-keywords">
            <span className="hint">From the query:</span>
            {suggestedKeywords.map((kw) => (
              <button
                key={kw}
                type="button"
                className="chip"
                onClick={() => {
                  const existing = new Set(keywords.map((k) => k.toLowerCase()));
                  if (existing.has(kw.toLowerCase())) return;
                  const next = keywordsText.trim()
                    ? `${keywordsText.trim()}, ${kw}`
                    : kw;
                  setKeywordsText(next);
                }}
              >
                + {kw}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="affiliation">Affiliation for this submission</label>
        <AffiliationPicker
          accessToken={session.accessToken}
          value={affiliationId}
          onChange={setAffiliationId}
        />
      </div>

      {mode === 'working' && aiToggleSection}

      {submitError && <div className="error">{submitError}</div>}

      <div className="submit-row">
        {mode === 'working' ? (
          <button
            type="submit"
            className="primary"
            disabled={!canSubmitWorking}
          >
            {submitting ? 'Submitting…' : 'Submit to koetai/sparql-examples'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={!canSubmitWorking}
              onClick={() => handleSubmit('working')}
              title={
                canSubmitWorking
                  ? 'The LLM-generated query passed the test. Submit it as a working example.'
                  : 'Test the LLM-generated query first; submit as working becomes available when it returns ≥1 row.'
              }
            >
              {submitting ? 'Submitting…' : 'Submit as working query'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!canSubmitRequest}
              onClick={() => handleSubmit('request')}
              title="File an issue asking a SPARQL expert to write or fix this query. Your NL description and LLM attempt are preserved."
            >
              {submitting ? 'Submitting…' : 'Submit request for expert help'}
            </button>
          </>
        )}
        {!canSubmitWorking && !canSubmitRequest && !submitting && (
          <p className="hint">
            {!title.trim()
              ? 'Add a title.'
              : !endpoint.trim()
                ? 'Pick an endpoint.'
                : !affiliationId
                  ? 'Pick the affiliation for this submission.'
                  : mode === 'request'
                    ? 'Add the natural-language description and pick the LLM you used.'
                    : testResult === null
                      ? 'Run a successful test query first.'
                      : testResult.rowCount === 0
                        ? 'Query returned 0 rows — adjust until it returns results.'
                        : aiSuggested && !naturalLanguageDescription.trim()
                          ? 'Add the original natural-language description.'
                          : ''}
          </p>
        )}
      </div>
    </form>
  );
}
