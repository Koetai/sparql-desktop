import { useMemo, useState } from 'react';
import { extractPrefixes, runQuery, type QueryResult } from '../lib/sparql';
import { submitQuery } from '../lib/api';
import type { OrcidSession } from '../auth/orcid';
import { YasqeEditor } from './YasqeEditor';
import { EndpointPicker } from './EndpointPicker';
import { AffiliationPicker } from './AffiliationPicker';
import { extractKeywordCandidates } from '../lib/keywords';

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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState(EXAMPLE_ENDPOINT);
  const [query, setQuery] = useState(EXAMPLE_QUERY);
  const [keywordsText, setKeywordsText] = useState('');

  const [affiliationId, setAffiliationId] = useState<string>('');

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

  const canSubmit =
    !!title.trim() &&
    !!endpoint.trim() &&
    !!query.trim() &&
    !!affiliationId &&
    testResult !== null &&
    testResult.rowCount > 0 &&
    !submitting &&
    (!aiSuggested || (!!naturalLanguageDescription.trim() && resolvedModel().length > 0));

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
      const r = await runQuery(endpoint, query);
      setTestResult(r);
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setSubmittedUrl(null);
    try {
      const result = await submitQuery(session.accessToken, {
        title: title.trim(),
        description: description.trim(),
        endpoint: endpoint.trim(),
        query,
        keywords,
        prefixes,
        selectedAffiliationId: affiliationId,
        aiSuggested,
        aiModel: aiSuggested ? resolvedModel() : undefined,
        naturalLanguageDescription: aiSuggested
          ? naturalLanguageDescription.trim()
          : undefined,
        originalAiQuery:
          aiSuggested && originalAiQuery.trim() ? originalAiQuery : undefined,
      });
      setSubmittedUrl(result.url);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

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
        if (canSubmit) handleSubmit();
      }}
    >
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

      <div className="field">
        <label>SPARQL query</label>
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
                Original AI suggestion <span className="hint-inline">(if you edited it)</span>
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

      {submitError && <div className="error">{submitError}</div>}

      <div className="submit-row">
        <button type="submit" className="primary" disabled={!canSubmit}>
          {submitting ? 'Submitting…' : 'Submit to koetai/sparql-examples'}
        </button>
        {!canSubmit && !submitting && (
          <p className="hint">
            {testResult === null
              ? 'Run a successful test query first.'
              : testResult.rowCount === 0
                ? 'Query returned 0 rows — adjust until it returns results.'
                : !title.trim()
                  ? 'Add a title.'
                  : !affiliationId
                    ? 'Pick the affiliation for this submission.'
                    : aiSuggested && !naturalLanguageDescription.trim()
                      ? 'Add the original natural-language description.'
                      : ''}
          </p>
        )}
      </div>
    </form>
  );
}
