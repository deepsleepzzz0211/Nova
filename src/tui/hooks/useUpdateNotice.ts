import { useEffect, useState } from 'react';
import { getUpdateNotice } from '../../update/update-check.js';

/**
 * Fire-and-forget update check at app start.
 * Returns a one-line notice for the StatusBar, or null when silent
 * (up to date / network failure / check never completed).
 */
export function useUpdateNotice(): string | null {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getUpdateNotice(__NOVA_VERSION__).then((n) => {
      if (!cancelled && n) setNotice(n);
    });
    return () => { cancelled = true; };
  }, []);

  return notice;
}
