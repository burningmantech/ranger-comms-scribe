import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { $generateNodesFromDOM } from '@lexical/html';
import { $createParagraphNode, $getRoot, $insertNodes, LexicalEditor } from 'lexical';
import { Modal } from './Modal';
import LexicalEditorComponent from '../editor/LexicalEditor';
import { $getPendingImageNodes } from '../editor/nodes/ImageNode';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry } from '../../types/commsCalendar';
import { cycleLabel, entryCycle, formatShortDate, localToday } from '../../utils/commsCalendar';
import { parseGoogleDoc, ParsedGoogleDoc, sheetHelperScript } from '../../utils/googleDocImport';

interface DocsImportModalProps {
  entries: CommsCalendarEntry[];
  /** The cycle whose entries the sheet's rows are (its start year). */
  cycle: number;
  userId: string;
  onClose: () => void;
  onDone: () => void;
}

interface Row {
  subject: string;
  link: string;
  parsed: ParsedGoogleDoc;
  entry?: CommsCalendarEntry;
  status: 'waiting' | 'working' | 'done' | 'failed' | 'skipped';
  note?: string;
}

const IMAGE_WAIT_MS = 2 * 60 * 1000;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The sheet's "htmlview" (links intact) for a Google Sheets link, keeping its tab (gid). */
function htmlviewUrl(sheetUrl: string): string | null {
  const id = sheetUrl.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1];
  if (!id) return null;
  const gid = sheetUrl.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/htmlview${gid ? `?gid=${gid}` : ''}`;
}

/**
 * Bring last year's messages into Scribe from the Comms queue sheet: each row's Google Doc becomes a
 * sent Scribe request (formatting kept, images copied to the gallery) on the calendar entry for the
 * cycle it went out in, which this year's entry continues.
 *
 * Google won't let Scribe read the documents itself, so Scribe opens the sheet in a tab of the same
 * browser, a short script there reads the documents with that browser's Google sign-in and posts
 * them back to this page.
 */
export const DocsImportModal: React.FC<DocsImportModalProps> = ({ entries, cycle, userId, onClose, onDone }) => {
  const [sheetUrl, setSheetUrl] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<LexicalEditor | null>(null);
  const setEditor = useCallback((editor: LexicalEditor | null) => {
    editorRef.current = editor;
  }, []);

  const cycleEntries = useMemo(() => entries.filter((e) => entryCycle(e) === cycle), [entries, cycle]);
  const script = useMemo(() => sheetHelperScript(window.location.origin), []);

  // The documents arrive from the sheet's tab
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://docs.google.com' || event.data?.kind !== 'scribe-docs-html') return;
      const docs = (event.data.docs || []) as Array<{ subject: string; link: string; html: string }>;
      const today = localToday();
      setRows(docs.map((doc) => {
        // A subject can repeat (a Scribe request sent under the same subject): prefer the sheet's own
        // rows (imported, no request yet), then imported ones
        const same = cycleEntries.filter((e) => norm(e.subject) === norm(doc.subject));
        const entry = same.find((e) => e.source === 'import' && !e.submissionId && !e.carriedFromId)
          || same.find((e) => e.source === 'import')
          || same[0];
        return {
          subject: doc.subject,
          link: doc.link,
          parsed: parseGoogleDoc(doc.html, today),
          entry,
          status: entry ? 'waiting' : 'skipped',
          ...(entry ? {} : { note: `No ${cycleLabel(cycle)} entry with this subject` }),
        };
      }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [cycleEntries, cycle]);

  const openSheet = () => {
    const url = htmlviewUrl(sheetUrl);
    if (!url) {
      setError('Paste the Google Sheets link (docs.google.com/spreadsheets/d/...)');
      return;
    }
    setError(null);
    window.open(url, '_blank');
  };

  /** The body as Lexical JSON, the way a paste would make it, once its images are in the gallery. */
  const convert = async (bodyHtml: string): Promise<{ json: string; text: string; imagesLeft: number }> => {
    const editor = editorRef.current;
    if (!editor) throw new Error('The converter is not ready');
    const dom = new DOMParser().parseFromString(bodyHtml, 'text/html');
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.select();
      $insertNodes($generateNodesFromDOM(editor, dom));
    }, { discrete: true });
    const started = Date.now();
    let pending = 1;
    while (Date.now() - started < IMAGE_WAIT_MS) {
      await sleep(400);
      pending = editor.getEditorState().read(() => $getPendingImageNodes().length);
      if (!pending) break;
    }
    return {
      json: JSON.stringify(editor.getEditorState()),
      text: editor.getEditorState().read(() => $getRoot().getTextContent()),
      imagesLeft: pending,
    };
  };

  const run = async () => {
    if (!rows) return;
    setRunning(true);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.status !== 'waiting' && row.status !== 'failed') continue;
      const update = (patch: Partial<Row>) => setRows((current) => current && current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      update({ status: 'working', note: undefined });
      try {
        const { json, text, imagesLeft } = await convert(row.parsed.bodyHtml);
        const result = await commsCalendarService.attachMessage(row.entry!.id, {
          title: row.parsed.subject || row.subject,
          content: text,
          richTextContent: json,
          link: row.link,
          ...(row.parsed.publishedOn ? { publishedOn: row.parsed.publishedOn } : {}),
        });
        const where = result.holder.id === row.entry!.id ? 'this entry' : `${cycleLabel(entryCycle(result.holder))}`;
        update({ status: 'done', note: `Request on ${where}${imagesLeft ? `; ${imagesLeft} image(s) couldn't be copied` : ''}` });
      } catch (err) {
        update({ status: 'failed', note: err instanceof Error ? err.message : String(err) });
      }
    }
    setRunning(false);
    onDone();
  };

  const waiting = rows?.filter((r) => r.status === 'waiting' || r.status === 'failed').length || 0;

  return (
    <Modal
      title="Import last year's messages from Google Docs"
      onClose={running ? () => undefined : onClose}
      wide
      footer={(
        <>
          <button type="button" className="cc-btn cc-btn--ghost" onClick={onClose} disabled={running}>Close</button>
          {rows && (
            <button type="button" className="cc-btn cc-btn--primary" onClick={run} disabled={running || !waiting}>
              {running ? 'Importing…' : `Import ${waiting} message${waiting === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      )}
    >
      {error && <div className="cc-error" role="alert">{error}</div>}
      {!rows ? (
        <div className="cc-docs-import">
          <p className="cc-muted">
            Each row's linked Google Doc becomes a sent Scribe request (formatting and images kept) on the{' '}
            {cycleLabel(cycle - 1)} entry it went out in, which this year's entry continues. Only the Subject and Body
            of the Comms request form are kept.
          </p>
          <ol>
            <li>
              <label className="cc-field">
                <span>The Comms queue sheet (open the right tab, then copy its link)</span>
                <input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…#gid=…" />
              </label>
              <button type="button" className="cc-btn cc-btn--small" onClick={openSheet} disabled={!sheetUrl.trim()}>Open the sheet</button>
              <span className="cc-muted cc-small"> in a new tab of this browser, signed in to Google with access to the documents.</span>
            </li>
            <li>
              In that tab, open the browser console (View → Developer → JavaScript Console), paste this and press Enter:
              <div className="cc-docs-script">
                <code>{script.slice(0, 90)}…</code>
                <button
                  type="button"
                  className="cc-btn cc-btn--small"
                  onClick={() => navigator.clipboard.writeText(script).then(() => setCopied(true))}
                >
                  {copied ? 'Copied' : 'Copy the script'}
                </button>
              </div>
            </li>
            <li>The documents arrive here; check the matches and import.</li>
          </ol>
          <p className="cc-muted cc-small">Waiting for the documents…</p>
        </div>
      ) : (
        <div className="cc-table-wrap">
          <table className="cc-table cc-table--compact">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Went out</th>
                <th>Entry ({cycleLabel(cycle)})</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} data-testid="docs-import-row">
                  <td>
                    <a href={row.link} target="_blank" rel="noopener noreferrer">{row.parsed.subject || row.subject}</a>
                    <div className="cc-muted cc-small">
                      {row.parsed.whole ? 'Whole document (no Body section)' : 'Body section'}
                      {row.parsed.images ? ` · ${row.parsed.images} image${row.parsed.images === 1 ? '' : 's'}` : ''}
                    </div>
                  </td>
                  <td className="cc-nowrap">{row.parsed.publishedOn ? formatShortDate(row.parsed.publishedOn, true) : <span className="cc-muted">Unknown</span>}</td>
                  <td>{row.entry ? `${row.entry.targetDate ? `${formatShortDate(row.entry.targetDate)} · ` : ''}${row.entry.subject}` : <span className="cc-missing">None</span>}</td>
                  <td className="cc-small">
                    <strong>{row.status}</strong>
                    {row.note && <div className="cc-muted">{row.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* The converter: the request editor itself, off screen, so pasted HTML and images are handled as in a paste */}
      <div className="cc-docs-converter" aria-hidden="true">
        <LexicalEditorComponent
          initialContent=""
          showToolbar={false}
          autoFocus={false}
          currentUserId={userId}
          canCreateSuggestions={false}
          onEditorReady={setEditor}
        />
      </div>
    </Modal>
  );
};

export default DocsImportModal;
