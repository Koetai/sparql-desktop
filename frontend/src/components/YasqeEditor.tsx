import { useEffect, useRef } from 'react';
// @triply/yasgui ships its own types, but they're not exported neatly; use any
// at the boundary and keep our props strongly typed.
import Yasgui from '@triply/yasgui';
import '@triply/yasgui/build/yasgui.min.css';

interface Props {
  defaultQuery: string;
  endpoint: string;
  onChange: (query: string) => void;
}

// Uncontrolled wrapper around YASQE (the editor part of YASGUI). The parent's
// `query` state is the source of truth for submission, but YASQE owns the
// editor's internal state after mount — initial value is seeded from
// `defaultQuery` once, then changes flow up via onChange only.
export function YasqeEditor({ defaultQuery, endpoint, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const yasqeRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';

    const YasqeCtor = (Yasgui as any).Yasqe;
    const yasqe = new YasqeCtor(host, {
      value: defaultQuery,
      requestConfig: { endpoint },
      showQueryButton: false,
      // Disable YASGUI's localStorage persistency. Without this, the editor
      // restores the previously-typed query and fires a `change` event that
      // overwrites our parent state — so a freshly-loaded issue would show
      // YASGUI's built-in default instead of the parsed query.
      persistencyExpire: 0,
    });
    yasqeRef.current = yasqe;

    // Explicit setValue after construction guarantees the desired query
    // wins over any internal restore path the constructor may take.
    try {
      yasqe.setValue(defaultQuery);
    } catch {
      /* tolerate API drift across yasgui versions */
    }

    yasqe.on('change', () => {
      onChangeRef.current(yasqe.getValue());
    });

    return () => {
      try {
        yasqe.destroy?.();
      } catch {
        /* yasqe may not always expose destroy across versions */
      }
      host.innerHTML = '';
      yasqeRef.current = null;
    };
    // intentionally no deps — mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const yasqe = yasqeRef.current;
    if (!yasqe) return;
    // Sync endpoint into YASQE's request config so its prefix autocomplete
    // and any internal previews use the right target.
    if (yasqe.options?.requestConfig) {
      yasqe.options.requestConfig.endpoint = endpoint;
    }
  }, [endpoint]);

  return <div ref={hostRef} className="yasqe-host" />;
}
