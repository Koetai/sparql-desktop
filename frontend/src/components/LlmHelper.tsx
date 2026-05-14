import { useMemo, useState } from 'react';

// LLM chat tools, ordered as the project lead specified. Each opens in a new
// tab. Most do not have a stable URL prefill parameter that handles long
// SPARQL prompts, so the universal pattern is: click Copy prompt, then click
// the tool, then paste into the chat. We surface that hint in the UI.
const LLM_TOOLS: { name: string; url: string; note?: string }[] = [
  {
    name: 'chat.expasy.org',
    url: 'https://chat.expasy.org',
    note: 'SIB-hosted assistant; tuned for life-science endpoints.',
  },
  {
    name: 'duck.ai',
    url: 'https://duck.ai',
    note: 'Anonymous; multiple models behind one chat.',
  },
  {
    name: 'uvachat',
    url: 'https://uvachat.uva.nl',
    note: 'UvA-hosted chat (verify URL for your institution).',
  },
  { name: 'Mistral', url: 'https://chat.mistral.ai/chat' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Copilot', url: 'https://copilot.microsoft.com' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
];

interface Props {
  endpoint: string;
  naturalLanguageDescription: string;
}

export function LlmHelper({ endpoint, naturalLanguageDescription }: Props) {
  const [copied, setCopied] = useState(false);

  const prompt = useMemo(
    () => buildPrompt(endpoint, naturalLanguageDescription),
    [endpoint, naturalLanguageDescription],
  );

  const canCopy = naturalLanguageDescription.trim().length > 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / locked clipboard — user can still select+copy manually
    }
  }

  return (
    <div className="llm-helper">
      <details className="llm-prompt">
        <summary>Preview the prompt that will be copied</summary>
        <pre>{prompt}</pre>
      </details>

      <div className="llm-actions">
        <button
          type="button"
          className="primary"
          onClick={copy}
          disabled={!canCopy}
          title={
            canCopy
              ? 'Copy the prompt to your clipboard, then click a tool below.'
              : 'Write the natural-language description first.'
          }
        >
          {copied ? '✓ Copied' : 'Copy prompt'}
        </button>
        <span className="hint">then open one of:</span>
      </div>

      <div className="llm-tools">
        {LLM_TOOLS.map((tool) => (
          <a
            key={tool.name}
            href={tool.url}
            target="_blank"
            rel="noreferrer"
            className="llm-tool"
            title={tool.note}
          >
            {tool.name}
            {tool.note && <span className="llm-tool-note">{tool.note}</span>}
          </a>
        ))}
      </div>

      <p className="hint">
        Paste the LLM's SPARQL into the editor below, click <em>Test query</em>,
        and submit. If it doesn't work after a few tries, you can submit a
        <em> request for expert help</em> instead.
      </p>
    </div>
  );
}

function buildPrompt(endpoint: string, nl: string): string {
  const question = nl.trim() || '<describe your question>';
  return [
    'You are a SPARQL expert. Write a SPARQL query that answers the question below against the given endpoint.',
    '',
    'Constraints:',
    '- Output the SPARQL query only — no prose, no explanation, no markdown fences.',
    '- Include all PREFIX declarations needed for the query to parse standalone.',
    '- Add LIMIT 25 unless the question implies otherwise.',
    '- Use the most-specific predicates the endpoint exposes.',
    '',
    `Endpoint: ${endpoint || '<not yet chosen>'}`,
    '',
    'Question:',
    question,
  ].join('\n');
}
