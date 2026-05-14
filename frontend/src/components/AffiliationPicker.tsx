import { useEffect, useState } from 'react';
import {
  AFFILIATION_NONE,
  fetchAffiliations,
  type AffiliationInfo,
} from '../lib/api';

interface Props {
  accessToken: string;
  value: string;
  onChange: (id: string) => void;
}

// Pulls the contributor's ORCID affiliations once (per login) and renders
// them as a dropdown the user must pick from. "None of these" is a valid
// explicit choice; selecting it shows a hint linking to ORCID's edit page
// so the user can add the missing affiliation and re-submit later.
export function AffiliationPicker({ accessToken, value, onChange }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<AffiliationInfo[]>([]);
  const [past, setPast] = useState<AffiliationInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await fetchAffiliations(accessToken);
      if (cancelled) return;
      if (!data) {
        setError(
          'Could not fetch affiliations from ORCID. The Worker may be offline. You can still submit with "None of these".',
        );
      } else {
        setCurrent(data.current ?? []);
        setPast(data.past ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  if (loading) {
    return <p className="hint">Loading your ORCID affiliations…</p>;
  }

  const hasAny = current.length + past.length > 0;
  const showNoneHint = value === AFFILIATION_NONE || (!hasAny && !error);

  return (
    <>
      <select
        id="affiliation"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      >
        <option value="">— Pick the affiliation for this submission —</option>
        {current.length > 0 && (
          <optgroup label="Current">
            {current.map((a) => (
              <option key={a.id} value={a.id}>
                {formatAffiliationLabel(a)}
              </option>
            ))}
          </optgroup>
        )}
        {past.length > 0 && (
          <optgroup label="Past">
            {past.map((a) => (
              <option key={a.id} value={a.id}>
                {formatAffiliationLabel(a)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={AFFILIATION_NONE}>None of these</option>
      </select>

      {error && <p className="hint error-inline">{error}</p>}

      {showNoneHint && (
        <p className="hint affiliation-none-hint">
          {hasAny
            ? 'If none of your ORCID affiliations fit, add or update them at '
            : 'You have no employments listed on your public ORCID record. Add or update them at '}
          <a
            href="https://orcid.org/my-orcid"
            target="_blank"
            rel="noreferrer"
          >
            orcid.org/my-orcid
          </a>{' '}
          and refresh this page.
        </p>
      )}
    </>
  );
}

function formatAffiliationLabel(a: AffiliationInfo): string {
  const role = [a.role, a.department].filter(Boolean).join(', ');
  const prefix = role ? `${role}, ` : '';
  const tag = a.rorUrl
    ? ' (ROR)'
    : a.gridId
      ? ' (GRID)'
      : a.ringgoldId
        ? ' (Ringgold)'
        : '';
  const span =
    a.startYear || a.endYear
      ? ` [${a.startYear ?? '?'}–${a.endYear ?? 'present'}]`
      : '';
  return `${prefix}${a.name}${tag}${span}`;
}
