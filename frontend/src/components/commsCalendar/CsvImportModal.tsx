import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry, ImportResult } from '../../types/commsCalendar';
import { parseCsv } from '../../utils/csv';
import { sheetToEntries } from '../../utils/commsCalendarImport';
import { cycleLabel, cycleStartYear, entryCycle, formatShortDate, localToday } from '../../utils/commsCalendar';

interface CsvImportModalProps {
  entries: CommsCalendarEntry[];
  onClose: () => void;
  onImported: () => void;
}

// Same rule as the server: one entry per subject (ignoring case) per cycle
function duplicateKey(subject: string, cycle: number): string {
  return `${subject.trim().toLowerCase()}|${cycle}`;
}

/** Import the Comms spreadsheet, exported from Google Sheets as CSV, with a preview. */
export const CsvImportModal: React.FC<CsvImportModalProps> = ({ entries, onClose, onImported }) => {
  const thisCycle = cycleStartYear(localToday());
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  // A first import is usually last cycle's sheet
  const [startYear, setStartYear] = useState(thisCycle - 1);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sheet = useMemo(
    () => (csvText === null ? null : sheetToEntries(parseCsv(csvText), startYear)),
    [csvText, startYear],
  );

  const existing = useMemo(() => new Set(entries.map((e) => duplicateKey(e.subject, entryCycle(e)))), [entries]);
  const isDuplicate = (subject: string | undefined, cycle: number) => !!subject && existing.has(duplicateKey(subject, cycle));

  const onFile = async (file: File | undefined) => {
    setResult(null);
    setError(null);
    setExcluded(new Set());
    if (!file) return;
    setFileName(file.name);
    setCsvText(await file.text());
  };

  const included = (sheet?.rows ?? []).filter((row) => row.input.subject && !excluded.has(row.line));

  const toggle = (line: number) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    return next;
  });

  const runImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await commsCalendarService.importEntries(included.map((row) => row.input));
      setResult(imported);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const years = [thisCycle - 3, thisCycle - 2, thisCycle - 1, thisCycle, thisCycle + 1];

  return (
    <Modal
      title="Import from the spreadsheet"
      onClose={onClose}
      wide
      footer={result ? (
        <button type="button" className="cc-btn cc-btn--primary" onClick={onClose}>Done</button>
      ) : (
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="cc-btn cc-btn--primary"
            onClick={runImport}
            disabled={importing || included.length === 0}
          >
            {importing ? 'Importing…' : `Import ${included.length} ${included.length === 1 ? 'row' : 'rows'}`}
          </button>
        </>
      )}
    >
      {error && <div className="cc-error" role="alert">{error}</div>}
      {result ? (
        <div className="cc-import-result">
          <p><strong>{result.created}</strong> added{result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}.</p>
          {result.skipped.length > 0 && (
            <ul>
              {result.skipped.map((s) => (
                <li key={s.index}>{included[s.index]?.input.subject || `Row ${included[s.index]?.line ?? s.index}`}: {s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <p className="cc-muted">
            In Google Sheets choose File → Download → Comma-separated values. Columns are matched by
            their headers (Email subject, Target send date, Method of Publishing, Date sent, Responsible
            Team, Comments; Link and Contacts if you add them). The export leaves out the subject links,
            so add a Link column first or fill links in afterwards.
          </p>
          <div className="cc-import-controls">
            <label className="cc-field">
              <span>CSV file</span>
              <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} aria-label="CSV file" />
            </label>
            <label className="cc-field">
              <span>The sheet covers</span>
              <select value={startYear} onChange={(e) => setStartYear(Number(e.target.value))} aria-label="Cycle">
                {years.map((y) => <option key={y} value={y}>Sep {y} – Aug {y + 1} ({cycleLabel(y)})</option>)}
              </select>
            </label>
          </div>
          {sheet?.error && <div className="cc-error" role="alert">{fileName}: {sheet.error}</div>}
          {sheet && !sheet.error && (
            <div className="cc-table-wrap">
              <table className="cc-table cc-table--compact">
                <thead>
                  <tr>
                    <th aria-label="Include" />
                    <th>Row</th>
                    <th>Subject</th>
                    <th>Target</th>
                    <th>Method</th>
                    <th>Sent</th>
                    <th>Team</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => {
                    const dated = row.input.targetDate || row.input.dateSent;
                    const duplicate = isDuplicate(row.input.subject, dated ? cycleStartYear(dated) : startYear);
                    return (
                      <tr key={row.line} className={!row.input.subject || excluded.has(row.line) ? 'cc-row--off' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!row.input.subject && !excluded.has(row.line)}
                            disabled={!row.input.subject}
                            onChange={() => toggle(row.line)}
                            aria-label={`Include row ${row.line}`}
                          />
                        </td>
                        <td>{row.line}</td>
                        <td>{row.input.subject}</td>
                        <td className="cc-nowrap">{formatShortDate(row.input.targetDate ?? undefined, true)}</td>
                        <td>{row.input.method}</td>
                        <td className="cc-nowrap">{formatShortDate(row.input.dateSent ?? undefined, true)}</td>
                        <td>{row.input.team}</td>
                        <td>
                          {duplicate && <div className="cc-tag cc-tag--warn">Already in the calendar</div>}
                          {row.warnings.map((w) => <div key={w} className="cc-warning">{w}</div>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
};

export default CsvImportModal;
