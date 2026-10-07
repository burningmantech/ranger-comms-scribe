import { useCallback, useEffect, useState } from 'react';
import { annualDatesService } from '../../services/annualDatesService';
import { AnnualDate } from '../../types/annualDates';

/** The annual dates table, loaded once per component, with a way to add a new entry to it. */
export function useAnnualDates() {
  const [entries, setEntries] = useState<AnnualDate[]>([]);
  const [canEditAll, setCanEditAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await annualDatesService.list();
      setEntries(result.entries);
      setCanEditAll(result.canEditAll);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const added = useCallback((entry: AnnualDate) => {
    setEntries((current) => [...current.filter((e) => e.id !== entry.id), entry].sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  return { entries, canEditAll, error, reload, added };
}
