import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type ChangeEvent, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';

import {
  csvToSnippetRows,
  IMPORT_BATCH_BYTES,
  IMPORT_MAX_FILE_BYTES,
  planBatches,
  type PreparedRow,
  splitMarkdownArticles,
} from '../../lib/kb-import';
import type {KbImportResult} from '../../lib/kb-types';
import {api, read} from '../api';
import {kbCategoriesQuery} from '../queries';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
  ErrorNote,
  Field,
  LoadingBlock,
  Notice,
  PageHeader,
  ProgressBar,
  rules,
  Select,
  StatusBadge,
  useForm,
  useToast,
} from '../ui';

/** A paste bigger than this is refused (import the rest in a second go). */
const MARKDOWN_MAX = 1_000_000;
/** Rows of the CSV shown before the import (plus the first rows with problems). */
const PREVIEW_ROWS = 10;
const PREVIEW_PROBLEMS = 20;
/** Skipped rows listed in the results (the count is always complete). */
const SKIPPED_SHOWN = 200;

const MD_RULES = {
  markdown: [
    rules.required('Paste the articles, each starting with a line like “# How to brew a pour-over”.'),
    rules.maxLength(MARKDOWN_MAX, `Paste at most ${MARKDOWN_MAX.toLocaleString()} characters at a time; import the rest in a second go.`),
  ],
  categoryId: [rules.required('Choose the category the articles go in.')],
};

type Kind = 'articles' | 'snippets';
type Skipped = {line: number; label: string; reason: string};

/** One import: how far it got, what was made, what was refused and why. */
interface Run {
  kind: Kind;
  /** Rows to send (the rest were refused before sending). */
  total: number;
  sent: number;
  created: number;
  skipped: Skipped[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  error: Error | null;
}

/** What the next request sends; kept in a ref so "Try again" carries on where it stopped. */
interface Job {
  kind: Kind;
  rows: PreparedRow[];
  batches: number[][];
  next: number;
}

type CsvState = {fileName: string; rows: PreparedRow[]} | {fileName: string; error: string} | null;

/**
 * Holders of `site:kb:edit`: bring in many articles or snippets at once
 * (`POST /site-api/kb/manage/import`). Files are read and checked in the
 * browser, then sent in small batches, ONE request at a time.
 */
export function Import() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const categories = useQuery(kbCategoriesQuery);
  const form = useForm({markdown: '', categoryId: ''}, MD_RULES);
  const [csv, setCsv] = useState<CsvState>(null);
  const [reading, setReading] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef<Job | null>(null);
  const stop = useRef(false);
  const busy = useRef(false);
  /** "Stop after this batch" was pressed: the button stays pending until the run ends. */
  const [stopping, setStopping] = useState(false);

  // Leaving the screen stops the import after the request in flight.
  useEffect(
    () => () => {
      stop.current = true;
    },
    []
  );

  const running = run?.status === 'running';

  // The pasted text, split as you type (deferred, so a big paste never blocks typing).
  const markdown = useDeferredValue(String(form.values.markdown));
  const found = useMemo(() => splitMarkdownArticles(markdown, 0), [markdown]);

  /** Sends the job's remaining batches one after the other. */
  const send = async () => {
    const current = job.current;
    if (!current || busy.current) return;
    busy.current = true;
    stop.current = false;
    setRun(state => state && {...state, status: 'running', error: null});
    let createdNow = 0;
    try {
      while (current.next < current.batches.length) {
        if (stop.current) {
          setRun(state => state && {...state, status: 'stopped'});
          return;
        }
        const batch = current.batches[current.next]!;
        const result = await read<KbImportResult>(
          api.kb.manage.import.$post({json: {rows: batch.map(index => current.rows[index]!.row!)}})
        );
        current.next++;
        createdNow += result.created;
        const skipped = result.skipped.map(({index, reason}) => {
          const source = current.rows[batch[index] ?? -1];
          return {line: source?.line ?? 0, label: source?.label ?? `Row ${index + 1} of the batch`, reason};
        });
        setRun(
          state =>
            state && {
              ...state,
              sent: state.sent + batch.length,
              created: state.created + result.created,
              skipped: [...state.skipped, ...skipped],
            }
        );
      }
      setRun(state => state && {...state, status: 'done'});
      job.current = null;
      if (current.kind === 'articles') form.reset({markdown: '', categoryId: String(form.values.categoryId)});
      else {
        setCsv(null);
        setFileKey(key => key + 1);
      }
      toast.success(current.kind === 'articles' ? 'Articles imported as drafts.' : 'Snippets imported.');
    } catch (err) {
      setRun(state => state && {...state, status: 'failed', error: err instanceof Error ? err : new Error('The import stopped.')});
    } finally {
      busy.current = false;
      // The run ended (done, stopped or failed): "Stop after this batch" is no longer pending.
      setStopping(false);
      if (createdNow) void queryClient.invalidateQueries({queryKey: ['kb']});
    }
  };

  /** Checks the rows, plans the batches, and starts sending. */
  const start = (kind: Kind, prepared: PreparedRow[]) => {
    if (busy.current) return;
    const ready = prepared.filter(row => row.row);
    const {batches, tooBig} = planBatches(ready.map(row => row.row!));
    const refused: Skipped[] = [
      ...prepared.filter(row => row.error).map(row => ({line: row.line, label: row.label, reason: row.error!})),
      ...tooBig.map(index => ({
        line: ready[index]!.line,
        label: ready[index]!.label,
        reason: `Too large to send in one go (over ${IMPORT_BATCH_BYTES / 1024} KB). Shorten it, or add it in the editor.`,
      })),
    ].sort((a, b) => a.line - b.line);
    job.current = {kind, rows: ready, batches, next: 0};
    setRun({
      kind,
      total: batches.reduce((sum, batch) => sum + batch.length, 0),
      sent: 0,
      created: 0,
      skipped: refused,
      status: 'running',
      error: null,
    });
    void send();
  };

  const importMarkdown = form.submit(values => {
    const {rows} = splitMarkdownArticles(String(values.markdown), Number(values.categoryId));
    if (!rows.length) {
      form.setServerErrors({markdown: 'No articles found. Start each article with a line like “# How to brew a pour-over”.'});
      return;
    }
    start('articles', rows);
  });

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return setCsv(null);
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      return setCsv({fileName: file.name, error: `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; use a file of at most ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB.`});
    }
    setReading(true);
    try {
      setCsv({fileName: file.name, rows: csvToSnippetRows(await file.text())});
    } catch (err) {
      setCsv({fileName: file.name, error: err instanceof Error ? err.message : 'The file could not be read. Save it as CSV and try again.'});
    } finally {
      setReading(false);
    }
  };

  const options = [
    {value: '', label: 'Choose a category'},
    ...(categories.data?.categories ?? []).map(category => ({value: String(category.id), label: category.name})),
  ];
  const noCategories = categories.isSuccess && categories.data.categories.length === 0;

  const csvRows = csv && 'rows' in csv ? csv.rows : null;
  const csvReady = csvRows?.filter(row => row.row).length ?? 0;
  const csvProblems = (csvRows?.length ?? 0) - csvReady;
  const preview = csvRows
    ? [...csvRows.slice(0, PREVIEW_ROWS), ...csvRows.slice(PREVIEW_ROWS).filter(row => row.error).slice(0, PREVIEW_PROBLEMS)]
    : [];

  const previewColumns: Column<PreparedRow>[] = [
    {key: 'line', header: 'Line', width: 'shrink', hideOnMobile: true, cell: row => row.line},
    {
      key: 'row',
      header: 'Question',
      cell: row => (
        <div className="import-row">
          <span className="cell-title">{row.row?.kind === 'snippet' ? row.row.question : row.label}</span>
          {row.row?.kind === 'snippet' && <span className="cell-sub import-clamp">{row.row.answer}</span>}
        </div>
      ),
    },
    {
      key: 'check',
      header: 'Check',
      cell: row =>
        row.error ? (
          <span className="import-problem">{row.error}</span>
        ) : (
          <StatusBadge tone="success">Ready</StatusBadge>
        ),
    },
  ];
  const skippedColumns: Column<Skipped>[] = [
    {key: 'line', header: 'Line', width: 'shrink', cell: row => (row.line ? row.line : '—')},
    {key: 'label', header: 'Row', cell: row => <span className="cell-title import-clamp">{row.label}</span>},
    {key: 'reason', header: 'Why it was skipped', cell: row => row.reason},
  ];

  return (
    <div className="app-page screen-import">
      <PageHeader
        title="Import"
        description="Bring in many articles or snippets at once. Articles come in as drafts, so you can check them before they go live."
      />

      {run && (
        <ImportProgress
          run={run}
          onRetry={() => void send()}
          onStop={() => {
            stop.current = true;
            setStopping(true);
          }}
          stopping={stopping}
          onDismiss={() => setRun(null)}
          skippedColumns={skippedColumns}
        />
      )}

      <div className="import-grid">
        <Card
          title="Paste Markdown"
          description="One article per “# ” heading: the heading is the title, the text under it is the article.">
          {categories.isPending ? (
            <LoadingBlock rows={2} />
          ) : categories.error ? (
            <ErrorNote error={categories.error} />
          ) : noCategories ? (
            <Notice
              tone="info"
              title="Add a category first"
              action={
                <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to="/categories">
                  Categories
                </Link>
              }>
              Every article belongs to a category. Add one, then come back to import.
            </Notice>
          ) : (
            <form className="form-stack" noValidate onSubmit={importMarkdown}>
              <Field id="f-categoryId" label="Category" error={form.error('categoryId')}>
                <Select {...form.field('categoryId')} options={options} disabled={running} />
              </Field>
              <Field
                id="f-markdown"
                label="Markdown"
                hint="Use ## for sections inside an article. Text before the first # heading is not imported."
                error={form.error('markdown')}>
                <textarea {...form.field('markdown')} rows={12} spellCheck={false} disabled={running} placeholder={'# How to brew a pour-over\n\n## What you need\n…'} />
              </Field>
              <p className="import-found">
                {found.rows.length === 0
                  ? 'No articles found yet.'
                  : `${found.rows.length} article${found.rows.length === 1 ? '' : 's'} found: ${found.rows
                      .slice(0, 5)
                      .map(row => `“${row.label}”`)
                      .join(', ')}${found.rows.length > 5 ? ` and ${found.rows.length - 5} more` : ''}.`}
                {found.rows.some(row => row.error) && ` ${found.rows.filter(row => row.error).length} will be skipped (the results say why).`}
              </p>
              <div className="form-actions">
                <Button type="submit" icon="file" pending={running && run?.kind === 'articles'} pendingLabel="Importing…" disabled={running || found.rows.length === 0}>
                  Import as drafts
                </Button>
              </div>
            </form>
          )}
        </Card>

        <Card title="Upload CSV of Q&A" description="Each row becomes a snippet the assistant can use.">
          <div className="form-stack">
            <Field
              id="f-csv"
              label="CSV file"
              hint={
                <>
                  The first row names the columns <code>question</code> and <code>answer</code>. Put a field in double quotes when it has a comma or a line
                  break.
                </>
              }
              error={csv && 'error' in csv ? csv.error : undefined}>
              <input
                key={fileKey}
                id="f-csv"
                type="file"
                accept=".csv,text/csv"
                disabled={running || reading}
                aria-invalid={csv && 'error' in csv ? true : undefined}
                aria-describedby={csv && 'error' in csv ? 'f-csv-error' : 'f-csv-hint'}
                onChange={event => void pickFile(event)}
              />
            </Field>

            {reading && <LoadingBlock rows={2} />}

            {csvRows && (
              <>
                <p className="import-found">
                  <strong>{csv!.fileName}</strong>: {csvReady.toLocaleString()} ready
                  {csvProblems > 0 && <>, {csvProblems.toLocaleString()} with problems (they are skipped)</>}.
                  {csvRows.length > PREVIEW_ROWS && ` Showing the first ${PREVIEW_ROWS} rows${csvProblems ? ' and rows with problems' : ''}.`}
                </p>
                <div className="import-preview">
                  <DataTable caption="Rows in the file" columns={previewColumns} rows={preview} rowKey={row => row.line} />
                </div>
                <div className="form-actions">
                  <Button
                    icon="zap"
                    pending={running && run?.kind === 'snippets'}
                    pendingLabel="Importing…"
                    disabled={running || csvReady === 0}
                    onClick={() => start('snippets', csvRows)}>
                    {`Import ${csvReady.toLocaleString()} snippet${csvReady === 1 ? '' : 's'}`}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={running}
                    onClick={() => {
                      setCsv(null);
                      setFileKey(key => key + 1);
                    }}>
                    Choose another file
                  </Button>
                </div>
              </>
            )}
            {csvRows && csvReady === 0 && <Notice tone="warning">No row in this file can be imported. Fix the problems listed above and choose it again.</Notice>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The running or finished import: progress, what was made, what was skipped and why. */
function ImportProgress({
  run,
  onRetry,
  onStop,
  onDismiss,
  skippedColumns,
  stopping,
}: {
  run: Run;
  onRetry: () => void;
  onStop: () => void;
  stopping: boolean;
  onDismiss: () => void;
  skippedColumns: Column<Skipped>[];
}) {
  const noun = run.kind === 'articles' ? 'article' : 'snippet';
  const plural = (n: number) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
  const title =
    run.status === 'running'
      ? `Importing ${noun}s…`
      : run.status === 'done'
        ? 'Import finished'
        : run.status === 'stopped'
          ? 'Import stopped'
          : 'Import interrupted';
  return (
    <Card
      title={title}
      description={run.status === 'running' ? 'Stay on this screen until it finishes.' : undefined}
      actions={
        run.status === 'running' ? (
          <Button variant="secondary" size="sm" pending={stopping} pendingLabel="Stopping…" onClick={onStop}>
            Stop after this batch
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )
      }>
      <div className="import-progress">
        <ProgressBar value={run.sent} max={Math.max(1, run.total)} label="Rows sent" />
        <p className="import-found" aria-live="polite">
          {run.sent.toLocaleString()} of {run.total.toLocaleString()} rows sent · {plural(run.created)} created
          {run.skipped.length > 0 && ` · ${run.skipped.length.toLocaleString()} skipped`}
        </p>

        {run.status === 'failed' && run.error && (
          <Notice
            tone="danger"
            title="The import stopped"
            action={
              <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
                Try the rest again
              </Button>
            }>
            {run.error.message} Rows sent before this are saved. Some rows of the batch that failed may already be in: check before trying again.
          </Notice>
        )}
        {run.status === 'stopped' && (
          <Notice
            tone="warning"
            action={
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Carry on
              </Button>
            }>
            Stopped with {(run.total - run.sent).toLocaleString()} rows still to send.
          </Notice>
        )}
        {run.status === 'done' && (
          <Notice
            tone="success"
            action={
              run.kind === 'articles' && run.created > 0 ? (
                <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to="/articles">
                  Review drafts
                </Link>
              ) : run.kind === 'snippets' && run.created > 0 ? (
                <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to="/snippets">
                  See snippets
                </Link>
              ) : undefined
            }>
            {plural(run.created)} created
            {run.kind === 'articles' && run.created > 0 ? ' as drafts: publish them from Articles when they read well.' : '.'}
          </Notice>
        )}

        {run.skipped.length > 0 && (
          <div className="import-skipped">
            <h4>
              Skipped <Badge tone="warning">{run.skipped.length.toLocaleString()}</Badge>
            </h4>
            <DataTable<Skipped & {n: number}>
              caption="Rows that were skipped"
              columns={skippedColumns}
              rows={run.skipped.slice(0, SKIPPED_SHOWN).map((row, n) => ({...row, n}))}
              rowKey={row => `${row.n}-${row.line}-${row.label}`}
            />
            {run.skipped.length > SKIPPED_SHOWN && (
              <p className="muted">And {(run.skipped.length - SKIPPED_SHOWN).toLocaleString()} more, for the same kinds of reasons.</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
