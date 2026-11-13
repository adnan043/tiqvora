import {type InfiniteData, type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type FormEvent, useEffect, useMemo, useRef, useState} from 'react';

import {ARTICLE_STATUS_LABELS, ARTICLE_STATUS_TONES} from '../../lib/helpdesk-tones';
import {
  KB_FILE_ACCEPT,
  KB_FILE_ACTIVE_STATES,
  KB_FILE_LIMITS,
  KB_FILE_MESSAGES,
  KB_FILE_NOT_REMOVED_MESSAGE,
  KB_FILE_TYPES,
  type KbFileDeleted,
  type KbFileDetail,
  type KbFileKind,
  kbFileKindOf,
  kbFileProblem,
  type KbFileRow,
  type KbFilesPage,
  type KbFilesUsage,
  type KbFileUploadStart,
} from '../../lib/kb-file-types';
import {putFile} from '../../platform/files-browser';
import {api, ApiError, read} from '../api';
import {kbCategoriesQuery, kbFileQuery, kbFilesPollQuery, kbFilesQuery, kbFilesUsageQuery} from '../queries';
import {ago, useMe, when} from '../shared';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  LoadingBlock,
  LoadMore,
  Menu,
  type MenuItem,
  Modal,
  Notice,
  PageHeader,
  ProgressBar,
  rules,
  Select,
  Skeleton,
  StatusBadge,
  type Tone,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

/**
 * Holders of `site:kb:edit`: upload a PDF, Word, text or Markdown file and get DRAFT articles
 * from it (`/site-api/kb/files`, src/server/routes/kb-files.ts). The bytes go straight from the
 * browser to the storage (`putFile`; the dashboard page allows it with `allowFileUploads`), then
 * the `kb-extract` job reads the file in the background. Nothing is published by this screen.
 *
 * Upload = three steps: ask (`POST /`), PUT the bytes (`putFile`), confirm (`POST /:id/complete`).
 * Following files being read (never the whole list): the first page only (kbFilesPollQuery), every
 * 4 s for the first minute then every 15 s, patched into the loaded list; paused while the detail
 * drawer follows its own file; every 60 s only once the files being read have not moved in 15 minutes
 * (a waiting file never counts as stuck).
 */

const MB = 1024 * 1024;
const FILE_HINT = `PDF or Word up to ${KB_FILE_LIMITS.pdfBytes / MB} MB, text or Markdown up to ${KB_FILE_LIMITS.textBytes / MB} MB.`;
const FILE_HINT_NO_PDF = `Word up to ${KB_FILE_LIMITS.docxBytes / MB} MB, text or Markdown up to ${KB_FILE_LIMITS.textBytes / MB} MB. PDFs need the assistant's AI key.`;
const REVIEW_NOTE = 'Drafts are never published on their own. Read each one, fix what the file got wrong, then publish it from Articles.';
const UPLOADED = 'Uploaded. Drafts appear here when the file has been read.';
const PDF_PRIVACY =
  'PDFs you upload are sent to our AI provider (Anthropic) to be read. Word, text and Markdown files are read on this site and are not sent anywhere.';

/**
 * Focus back where it was when a drawer or dialog closes (they unmount, so the browser can't):
 * call the returned function as it opens; the element focused then gets focus back on close, or
 * the page heading when that element is gone.
 */
function useReturnFocus(open: boolean) {
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open || !trigger.current) return;
    const element = trigger.current;
    trigger.current = null;
    if (element.isConnected) element.focus();
    else focusHeadingIfLost();
  }, [open]);
  return () => {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
}

/** Focus fell to the page (its element left): put it on the page heading instead. */
function focusHeadingIfLost() {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const heading = document.querySelector<HTMLElement>('h1.app-title');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus();
  });
}

/**
 * After a row leaves (delete) or a dialog closes: the list commits and the dialog restores its own
 * focus a moment after the refetch settles, so check now, after that frame, and once more later.
 */
function focusHeadingSoon() {
  focusHeadingIfLost();
  window.setTimeout(focusHeadingIfLost, 250);
}

/** Focus fell to the page while a row was busy: back on that row's Actions menu (data-file-id). */
function focusRowIfLost(id: number) {
  const run = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const trigger = document.querySelector<HTMLElement>(`[data-file-id="${id}"] button`);
    if (trigger && !(trigger as HTMLButtonElement).disabled) trigger.focus();
    else focusHeadingIfLost();
  };
  // Now, and again after a closing dialog has put its own focus back.
  requestAnimationFrame(run);
  window.setTimeout(run, 250);
}

/** "812 bytes", "24 KB", "2.4 MB", "3.2 GB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1).replace(/\.0$/, '')} GB`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isActive = (row: KbFileRow) => KB_FILE_ACTIVE_STATES.includes(row.state);

const POLL_FAST_MS = 4000;
const POLL_SLOW_MS = 15_000;
/** Fast polling lasts this long, then slows down. */
const POLL_FAST_FOR_MS = 60_000;
/** A file being read that has not moved for this long is stuck: checked only every 60 s. */
const STALL_MS = 15 * 60_000;
/** A stuck file is still checked now and then (a job may pick it up again). */
const POLL_STALLED_MS = 60_000;

/** When each file last moved: its `updatedAt`, or (unreadable) when this screen saw it change. */
const lastMoved = new Map<number, {sig: string; at: number}>();
function movedAt(row: KbFileRow): number {
  const parsed = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const sig = `${row.state}|${row.pagesDone}|${row.pagesTotal}|${row.draftsCreated}`;
  const seen = lastMoved.get(row.id);
  if (seen && seen.sig === sig) return seen.at;
  const now = Date.now();
  lastMoved.set(row.id, {sig, at: now});
  return now;
}
/** Being read and still moving: worth polling for. */
// A `queued` file is never stuck: jobs run one at a time, so it may wait behind a long PDF.
const isFollowed = (row: KbFileRow) => isActive(row) && (row.state === 'queued' || Date.now() - movedAt(row) < STALL_MS);
/** 4 s for the first minute of following, then 15 s. */
const pollPace = (since: number) => (Date.now() - since < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
/** How often to check these rows: the pace while one moves, every 60 s while only stuck ones are left, else never. */
function pollEvery(rows: KbFileRow[], since: number): number | false {
  if (rows.some(isFollowed)) return pollPace(since);
  return rows.some(isActive) ? POLL_STALLED_MS : false;
}

/** Newer copies of some rows into the loaded list (no refetch of its pages). */
function patchRows(queryClient: QueryClient, fresh: KbFileRow[]) {
  if (!fresh.length) return;
  const byId = new Map(fresh.map(row => [row.id, row]));
  queryClient.setQueryData<InfiniteData<KbFilesPage, string | undefined>>(kbFilesQuery.queryKey, data => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map(page => {
      let pageChanged = false;
      const items = page.items.map(row => {
        const next = byId.get(row.id);
        if (!next) return row;
        const {drafts: _drafts, ...plain} = next as KbFileDetail;
        pageChanged = changed = true;
        return {...row, ...plain};
      });
      return pageChanged ? {...page, items} : page;
    });
    return changed ? {...data, pages} : data;
  });
}

/** A row's status in words and a tone (colour is never the only signal). */
export function fileStatus(row: KbFileRow): {tone: Tone; label: string} {
  switch (row.state) {
    case 'uploading':
      return {tone: 'neutral', label: 'Uploading'};
    case 'queued':
      return {tone: 'neutral', label: 'Waiting'};
    case 'extracting':
      return {
        tone: 'info',
        label: row.kind === 'pdf' && row.pagesTotal ? `Reading · page ${Math.min(row.pagesDone + 1, row.pagesTotal)} of ${row.pagesTotal}` : 'Reading',
      };
    case 'drafted':
      return row.draftsCreated > 0
        ? {
            tone: 'success',
            label: plural(row.draftsCreated, 'draft', 'drafts'),
          }
        : {tone: 'neutral', label: 'No drafts'};
    case 'failed':
      return {
        tone: 'danger',
        label: row.couldNotRead ? "Couldn't read" : 'Failed',
      };
    case 'cancelled':
      return {tone: 'neutral', label: 'Cancelled'};
  }
}

/** Why a picked file can't be uploaded (the same rules as the server), or null. */
function pickProblem(file: File | null, pdfReady: boolean | undefined): string | null {
  if (!file) return 'Choose a file to upload.';
  const kind = kbFileKindOf(file.name);
  // The type first (without PDF when PDFs can't be read), then "PDFs need the AI key", then the size.
  if (!kind) return pdfReady === false ? KIND_NO_PDF : KB_FILE_MESSAGES.kind;
  if (kind === 'pdf' && pdfReady === false) return KB_FILE_MESSAGES.pdfNeedsAi;
  const problem = kbFileProblem(file.name, file.size);
  if (problem) return problem;
  if (file.name.trim().length > KB_FILE_LIMITS.nameChars) return NAME_TOO_LONG;
  return null;
}

/** A file picker can't edit the name: say what to do instead. */
const NAME_TOO_LONG = `Rename the file to ${KB_FILE_LIMITS.nameChars} characters or fewer and pick it again.`;
const KIND_NO_PDF = 'Pick a Word (.docx), text (.txt) or Markdown (.md) file.';

/** A failed PUT to the storage (step 2), in its words. */
class PutError extends Error {}

/** Row actions failing, in words (by the server's `code`, never its text). */
function actionErrorText(err: unknown, action: 'retry' | 'cancel' | 'delete'): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'This file is no longer there.';
    if (err.code === 'pdf_needs_ai') return KB_FILE_MESSAGES.pdfNeedsAi;
    if (err.code === 'rate_limited' || err.status === 429) return err.message;
    if (err.code === 'already_finished' || (action === 'cancel' && err.status === 409)) return 'It already finished.';
    // "Tried too many times", "only a failed or stopped file…": the server's own words.
    if (err.code === 'already_started') return err.message;
    if (err.status === 409) return 'This file changed meanwhile. The list has been refreshed.';
    if (err.status === 422) return err.fields.categoryId ?? err.message;
    // Other refusals (limits, budget) come in plain words.
    if (err.code && err.status < 500 && err.message) return err.message;
  }
  if (action === 'delete') return "Couldn't delete the file. Try again.";
  return "That didn't work. Check your connection and try again.";
}

type Phase = 'checking' | 'uploading' | 'starting';
const PHASE_LABELS: Record<Phase, string> = {
  checking: 'Checking…',
  uploading: 'Uploading…',
  starting: 'Starting…',
};

/** The route: only holders of `site:kb:edit` (editKnowledge) get the screen; others one notice. */
export function Files() {
  const me = useMe();
  if (me.isPending) return <LoadingBlock rows={4} />;
  if (me.isError) return <ErrorNote title="This page could not load" error={me.error} />;
  if (!me.data?.abilities.editKnowledge) {
    return (
      <div className="app-page">
        <EmptyState
          icon="lock"
          title="Knowledge files are for your knowledge editors"
          action={
            <Link className={buttonClass({variant: 'secondary'})} to="/">
              Back to the overview
            </Link>
          }>
          Ask an admin for a role that can edit the knowledge base.
        </EmptyState>
      </div>
    );
  }
  return <FilesScreen />;
}

function FilesScreen() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const usage = useQuery(kbFilesUsageQuery);
  // Never polls itself: the first page is followed below while a file is being read.
  const files = useInfiniteQuery(kbFilesQuery);
  const rows = useMemo(() => files.data?.pages.flatMap(page => page.items), [files.data]);
  // After a write: the list and any open file. Storage changes only on an upload or a delete.
  const refresh = (opts: {usage?: boolean} = {}) =>
    Promise.all([
      queryClient.invalidateQueries({queryKey: ['kb', 'files', 'list']}),
      queryClient.invalidateQueries({queryKey: ['kb', 'files', 'file']}),
      opts.usage ? queryClient.invalidateQueries({queryKey: kbFilesUsageQuery.queryKey}) : undefined,
    ]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  // Follow files being read: the first page only, paused while the drawer follows its own file.
  const following = useMemo(() => (rows ?? []).some(isActive), [rows]);
  const pollOn = following && detailId === null;
  const pollSince = useRef(0);
  if (!pollOn) pollSince.current = 0;
  else if (!pollSince.current) pollSince.current = Date.now();
  const poll = useQuery({
    ...kbFilesPollQuery,
    enabled: pollOn,
    // Seeded with the list's first page: the first request waits one interval.
    initialData: () => files.data?.pages[0],
    initialDataUpdatedAt: () => files.dataUpdatedAt,
    staleTime: POLL_FAST_MS,
    refetchInterval: q => pollEvery(q.state.data?.items ?? [], pollSince.current || Date.now()),
  });
  useEffect(() => {
    const page = poll.data;
    if (!page || page === files.data?.pages[0]) return;
    // Someone uploaded meanwhile: a row newer than the list's newest means a fresh list.
    const newest = files.data?.pages[0]?.items[0]?.id ?? 0;
    if (page.items.some(row => row.id > newest)) void queryClient.invalidateQueries({queryKey: ['kb', 'files', 'list']});
    else patchRows(queryClient, page.items);
  }, [poll.data]);
  const [retrying, setRetrying] = useState<KbFileRow | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);
  const rememberUploadTrigger = useReturnFocus(uploadOpen);
  const rememberDetailTrigger = useReturnFocus(detailId !== null);
  const rememberRetryTrigger = useReturnFocus(retrying !== null);
  // A row whose menu was swapped for a pending button: its menu gets focus back once it is idle.
  const refocusRow = useRef<number | null>(null);

  // A file that finishes while the screen is open: one toast per file.
  const watching = useRef(new Set<number>());
  useEffect(() => {
    for (const row of rows ?? []) {
      if (isActive(row)) watching.current.add(row.id);
      else if (watching.current.delete(row.id)) {
        if (row.state === 'drafted') {
          // New drafts: the Articles list, the overview and its Drafts tile show them without a reload.
          void queryClient.invalidateQueries({queryKey: ['kb', 'articles']});
          void queryClient.invalidateQueries({
            queryKey: ['helpdesk', 'reports', 'overview'],
          });
          void queryClient.invalidateQueries({
            queryKey: ['helpdesk', 'stats'],
          });
          toast.success(
            row.draftsCreated > 0
              ? `“${row.name}” is ready: ${plural(row.draftsCreated, 'draft', 'drafts')} in Articles.`
              : `“${row.name}” was read, but no drafts came out of it.`
          );
        } else if (row.state === 'failed') {
          toast.danger(row.couldNotRead ? `We couldn't read “${row.name}”.` : `Reading “${row.name}” failed.`);
        }
      }
    }
  }, [rows, toast, queryClient]);

  const cancel = useMutation({
    mutationFn: (row: KbFileRow) => read<{file: KbFileRow}>(api.kb.files[':id'].cancel.$post({param: {id: String(row.id)}})),
    onMutate: row => {
      setRowError(null);
      refocusRow.current = row.id;
    },
    onSuccess: (_res, row) => {
      toast.success(`Stopped reading “${row.name}”.`);
      return refresh();
    },
    onError: err => {
      setRowError(actionErrorText(err, 'cancel'));
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (row: KbFileRow) => read<KbFileDeleted>(api.kb.files[':id'].$delete({param: {id: String(row.id)}})),
  });

  const busyId = cancel.isPending ? cancel.variables.id : remove.isPending ? remove.variables.id : null;
  useEffect(() => {
    if (busyId !== null || refocusRow.current === null) return;
    const id = refocusRow.current;
    refocusRow.current = null;
    focusRowIfLost(id);
  }, [busyId]);

  const askDelete = (row: KbFileRow) => {
    let result: KbFileDeleted | undefined;
    void confirm({
      title: `Delete “${row.name}”?`,
      body: 'The file is deleted. Drafts made from it stay in Articles.',
      confirmLabel: 'Delete file',
      pendingLabel: 'Deleting…',
      action: () =>
        remove.mutateAsync(row).then(
          res => {
            result = res;
          },
          (err: unknown) => {
            throw new Error(actionErrorText(err, 'delete'));
          }
        ),
    }).then(ok => {
      if (!ok) return focusRowIfLost(row.id);
      if (result && !result.fileDeleted) {
        // Not a plain success: it stays on the page (a toast would vanish), in words.
        setRowError(null);
        setDeleteNote(`“${row.name}”: ${result.message ?? KB_FILE_NOT_REMOVED_MESSAGE}`);
      } else {
        toast.success(`“${row.name}” deleted.`);
      }
      if (detailId === row.id) setDetailId(null);
      void refresh({usage: true}).then(focusHeadingSoon);
    });
  };

  // A new tab: the app (and anything typed in it) stays; a refusal shows there in words.
  const download = (row: KbFileRow) => window.open(`/site-api/kb/files/${row.id}/view?download=1`, '_blank', 'noopener');

  const storage = usage.data?.storage;
  const storageBlocked = storage === 'needs_pack' || storage === 'off';
  const openUpload = () => {
    setRowError(null);
    setDeleteNote(null);
    rememberUploadTrigger();
    setUploadOpen(true);
  };
  const openDetail = (id: number) => {
    rememberDetailTrigger();
    setDetailId(id);
  };
  const openRetry = (row: KbFileRow) => {
    rememberRetryTrigger();
    setRetrying(row);
  };
  const uploadButton = (
    <Button icon="upload" onClick={openUpload} disabled={storageBlocked}>
      Upload a file
    </Button>
  );

  const columns: Column<KbFileRow>[] = [
    {
      key: 'name',
      header: 'File',
      cell: row => {
        const note = row.error || (row.state === 'failed' && row.couldNotRead ? KB_FILE_MESSAGES.couldNotRead : '');
        return (
          <div className="screen-files-name">
            <span className="cell-title">{row.name}</span>
            <span className="screen-files-meta">
              <Badge>{KB_FILE_TYPES[row.kind].label}</Badge>
              <span className="cell-sub">{fileSize(row.size)}</span>
              {row.kind === 'pdf' && row.costCents > 0 && <span className="cell-sub">AI cost {money(row.costCents)}</span>}
            </span>
            {note && <span className={row.state === 'failed' ? 'screen-files-error' : 'cell-sub'}>{note}</span>}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: row => {
        const status = fileStatus(row);
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
    },
    {
      key: 'category',
      header: 'Category',
      hideOnMobile: true,
      cell: row => row.category?.name ?? '—',
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => (
        <div>
          <time dateTime={row.createdAt} title={when(row.createdAt)}>
            {ago(row.createdAt)}
          </time>
          <span className="cell-sub">by {row.uploadedBy}</span>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: row => {
        if (busyId === row.id)
          return (
            <span data-file-id={row.id}>
              <IconButton icon="more" label={`Working on “${row.name}”`} size="sm" pending />
            </span>
          );
        const items: MenuItem[] = [
          {
            label: row.state === 'drafted' ? 'View drafts' : 'View details',
            icon: 'eye',
            onSelect: () => openDetail(row.id),
          },
        ];
        if (row.state !== 'uploading')
          items.push({
            label: 'Download',
            icon: 'file',
            onSelect: () => download(row),
          });
        if (row.state === 'failed' || row.state === 'cancelled')
          items.push({
            label: 'Try again',
            icon: 'refresh',
            onSelect: () => openRetry(row),
          });
        if (isActive(row))
          items.push({
            label: 'Stop reading',
            icon: 'ban',
            onSelect: () => cancel.mutate(row),
          });
        items.push('separator', {
          label: 'Delete',
          icon: 'trash',
          danger: true,
          onSelect: () => askDelete(row),
        });
        return (
          <span data-file-id={row.id}>
            <Menu label={`Actions for “${row.name}”`} disabled={busyId !== null} items={items} />
          </span>
        );
      },
    },
  ];

  return (
    <div className="app-page screen-files">
      <PageHeader
        title="Knowledge files"
        description="Upload PDF, Word, text or Markdown files. They are read into draft articles you check before anything is published."
        actions={uploadButton}
      />

      <SpaceCard usage={usage.data} loading={usage.isPending} failed={usage.isError} />

      {rowError && <Notice tone="danger">{rowError}</Notice>}
      {deleteNote && (
        <Notice
          tone="warning"
          title="Stored copy not deleted"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDeleteNote(null);
                focusHeadingIfLost();
              }}>
              Dismiss
            </Button>
          }>
          {deleteNote}
        </Notice>
      )}

      <Card flush>
        <DataTable
          caption="Uploaded files"
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          loading={files.isPending}
          error={files.error}
          busyKey={busyId}
          empty={
            <EmptyState
              icon="upload"
              title="No files yet"
              action={
                <Button onClick={openUpload} disabled={storageBlocked}>
                  Upload a file
                </Button>
              }>
              Turn a manual, a policy document or an FAQ into draft articles.
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={files} />

      <UploadDrawer
        open={uploadOpen}
        pdfReady={usage.data?.pdfReady}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setUploadOpen(false);
          toast.success(UPLOADED);
          // Focus goes back to "Upload a file"; the empty state's copy may leave with the new row.
          void refresh({usage: true}).then(focusHeadingSoon);
        }}
      />
      <DetailDrawer id={detailId} onClose={() => setDetailId(null)} />
      <RetryModal
        file={retrying}
        pdfReady={usage.data?.pdfReady}
        onClose={() => setRetrying(null)}
        onDone={row => {
          setRetrying(null);
          toast.success(`Reading “${row.name}” again.`);
          void refresh();
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ space --

/** How much storage is left, and whether PDFs can be read. */
function SpaceCard({usage, loading, failed}: {usage: KbFilesUsage | undefined; loading: boolean; failed: boolean}) {
  const canSetUp = useMe().data?.abilities.manageHelpdesk === true;
  if (loading) {
    return (
      <Card title="Space">
        <Skeleton width="half" />
      </Card>
    );
  }
  const pdfNote = usage?.pdfReady === false && (
    <Notice tone="info">
      PDFs are read by the assistant, so they need its AI key and a monthly budget.{' '}
      {canSetUp ? (
        <Link to="/assistant">Set them up in Assistant</Link>
      ) : (
        'Ask someone who manages the Assistant settings to set them up'
      )}
      . Word, text and Markdown files work without it.
    </Notice>
  );
  if (failed || !usage || usage.storage === 'unavailable' || usage.storage === 'unreachable') {
    return (
      <>
        <Notice tone="info">Couldn't check the space left. You can still try an upload.</Notice>
        {pdfNote}
      </>
    );
  }
  if (usage.storage === 'needs_pack') {
    return (
      <>
        <Notice tone="warning" title="Storage is not set up">
          Add a storage pack in your dashboard's Storage tab, then turn Storage on.
        </Notice>
        {pdfNote}
      </>
    );
  }
  if (usage.storage === 'off') {
    return (
      <>
        <Notice tone="warning" title="Storage is off">
          Turn Storage on in your dashboard's Storage tab.
        </Notice>
        {pdfNote}
      </>
    );
  }
  const used = usage.usedBytes ?? 0;
  const limit = usage.limitBytes;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <>
      <Card title="Space" description="Storage is shared by everything on your account.">
        {limit ? (
          <div className="screen-files-space">
            <p>
              {fileSize(Math.max(0, limit - used))} left of {fileSize(limit)}
            </p>
            <ProgressBar value={Math.min(used, limit)} max={limit} label={`Storage used: ${pct}%`} valueText={`${fileSize(used)} of ${fileSize(limit)} used`} />
          </div>
        ) : (
          <p>No storage limit. {fileSize(used)} used.</p>
        )}
      </Card>
      {pdfNote}
    </>
  );
}

// ----------------------------------------------------------------- upload --

const UPLOAD_RULES = {
  categoryId: [rules.required(KB_FILE_MESSAGES.category)],
};

function UploadDrawer({open, pdfReady, onClose, onUploaded}: {open: boolean; pdfReady: boolean | undefined; onClose: () => void; onUploaded: () => void}) {
  const categories = useQuery({...kbCategoriesQuery, enabled: open});
  const list = categories.data?.categories ?? [];
  const form = useForm({categoryId: ''}, UPLOAD_RULES);
  const [file, setFile] = useState<File | null>(null);
  const [fileTried, setFileTried] = useState(false);
  const [fileServerError, setFileServerError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Opened again: start clean. One category: pick it.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFileTried(false);
    setFileServerError(null);
    setFailure(null);
    setPhase(null);
    form.reset({categoryId: ''});
  }, [open]);
  useEffect(() => {
    if (open && list.length === 1 && !form.values.categoryId) form.set('categoryId', String(list[0]!.id));
  }, [open, list.length]);

  const upload = useMutation({
    mutationFn: async ({file: picked, categoryId}: {file: File; categoryId: number}) => {
      setPhase('checking');
      const start = await read<KbFileUploadStart>(
        api.kb.files.$post({
          json: {name: picked.name.trim(), size: picked.size, categoryId},
        })
      );
      setPhase('uploading');
      const put = await putFile(start.upload, picked);
      if (!put.ok) {
        // The row would wait in "Uploading" for nothing: remove it (and the empty upload).
        void read(api.kb.files[':id'].$delete({param: {id: String(start.file.id)}})).catch(() => undefined);
        throw new PutError(put.message);
      }
      setPhase('starting');
      return read<{file: KbFileRow}>(
        api.kb.files[':id'].complete.$post({
          param: {id: String(start.file.id)},
        })
      );
    },
    onMutate: () => {
      setFailure(null);
      setFileServerError(null);
    },
    onSuccess: () => onUploaded(),
    onError: err => {
      if (err instanceof PutError) return setFailure(err.message);
      if (err instanceof ApiError) {
        if (err.code === 'pdf_needs_ai') return focusFile(KB_FILE_MESSAGES.pdfNeedsAi);
        if (err.status === 422 && (err.fields.name || err.fields.size)) return focusFile(err.fields.name ? NAME_TOO_LONG : err.fields.size!);
        if (err.status === 422 && err.fields.categoryId) return form.setServerErrors({categoryId: err.fields.categoryId});
        if (err.code === 'storage_unavailable') return setFailure("File storage isn't available here.");
        return setFailure(err.message);
      }
      setFailure("The upload didn't start. Check your connection and try again.");
    },
    onSettled: () => setPhase(null),
  });

  const focusFile = (message: string) => {
    setFileServerError(message);
    fileInput.current?.focus();
  };

  const fileError = fileServerError ?? (fileTried ? (pickProblem(file, pdfReady) ?? undefined) : undefined);
  const busy = upload.isPending;
  const close = () => {
    if (!busy) onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFileTried(true);
    const problem = pickProblem(file, pdfReady);
    if (problem) {
      // Show every error, then focus the first wrong field (the file comes first).
      form.submit(() => undefined)();
      fileInput.current?.focus();
      return;
    }
    form.submit(values => upload.mutate({file: file!, categoryId: Number(values.categoryId)}))();
  };

  const noCategories = categories.isSuccess && list.length === 0;
  const kind: KbFileKind | null = file ? kbFileKindOf(file.name) : null;
  const statusText =
    phase === 'checking' ? 'Checking the file…' : phase === 'uploading' ? `Uploading “${file?.name}”…` : phase === 'starting' ? 'Starting…' : '';

  return (
    <Drawer
      open={open}
      onClose={close}
      dismissible={!busy}
      title="Upload a file"
      description="It is read into draft articles in the category you pick. Nothing is published until you publish it."
      onSubmit={noCategories ? undefined : submit}
      footer={
        noCategories ? undefined : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" icon="upload" pending={busy} pendingLabel={phase ? PHASE_LABELS[phase] : 'Checking…'}>
              Upload
            </Button>
          </>
        )
      }>
      {categories.isPending ? (
        <LoadingBlock rows={2} />
      ) : categories.error ? (
        <ErrorNote title="The categories could not load" error={categories.error} />
      ) : noCategories ? (
        <EmptyState
          icon="menu"
          title="Add a category first"
          action={
            <Link to="/categories" className={buttonClass({variant: 'secondary'})}>
              Go to Categories
            </Link>
          }>
          Drafts made from a file go in a category.
        </EmptyState>
      ) : (
        <div className="form-stack">
          <Field id="f-file" label="File" hint={pdfReady === false ? FILE_HINT_NO_PDF : FILE_HINT} error={fileError}>
            <input
              id="f-file"
              ref={fileInput}
              type="file"
              className="file-input"
              accept={
                pdfReady === false
                  ? KB_FILE_ACCEPT.split(',')
                      .filter(ext => ext !== '.pdf')
                      .join(',')
                  : KB_FILE_ACCEPT
              }
              disabled={busy}
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? 'f-file-error' : 'f-file-hint'}
              onChange={event => {
                setFile(event.target.files?.[0] ?? null);
                setFileServerError(null);
                setFailure(null);
                // Checked as soon as a file is picked: say what is wrong before any upload.
                setFileTried(true);
              }}
            />
          </Field>
          {file && kind && !fileError && (
            <p className="muted screen-files-picked">
              {KB_FILE_TYPES[kind].label} · {fileSize(file.size)}
            </p>
          )}
          <Field id="f-categoryId" label="Category for the drafts" error={form.error('categoryId')}>
            <Select
              {...form.field('categoryId')}
              disabled={busy}
              options={[{value: '', label: 'Choose a category'}, ...list.map(c => ({value: String(c.id), label: c.name}))]}
            />
          </Field>
          <Notice tone="info">{REVIEW_NOTE}</Notice>
          {pdfReady !== false && <p className="muted screen-files-privacy">{PDF_PRIVACY}</p>}
          <p className="visually-hidden" role="status">
            {statusText}
          </p>
          {failure && (
            <p className="field-error" role="alert">
              {failure}
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ----------------------------------------------------------------- detail --

function DetailDrawer({id, onClose}: {id: number | null; onClose: () => void}) {
  const queryClient = useQueryClient();
  const since = useRef({id, at: Date.now()});
  if (since.current.id !== id) since.current = {id, at: Date.now()};
  const query = useQuery({
    ...kbFileQuery(id ?? 0),
    enabled: id !== null,
    // Follow a file that is still being read (4 s, then 15 s; not once it has stopped moving).
    refetchInterval: q => pollEvery(q.state.data ? [q.state.data.file] : [], since.current.at),
  });
  const file: KbFileDetail | undefined = query.data?.file;
  // The list is paused meanwhile: keep its row in step with what the drawer sees.
  useEffect(() => {
    if (file) patchRows(queryClient, [file]);
  }, [file, queryClient]);
  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      title={file?.name ?? 'File'}
      description={file ? `${KB_FILE_TYPES[file.kind].label} · ${fileSize(file.size)}` : undefined}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }>
      {query.isPending ? (
        <LoadingBlock rows={4} />
      ) : !file ? (
        <ErrorNote
          title="This file could not load"
          error={
            query.error instanceof ApiError && query.error.status === 404 ? new Error('It was deleted.') : (query.error ?? new Error('Something went wrong.'))
          }
        />
      ) : (
        <FileDetail file={file} />
      )}
    </Drawer>
  );
}

function FileDetail({file}: {file: KbFileDetail}) {
  const status = fileStatus(file);
  const items = [
    {
      label: 'Status',
      value: <StatusBadge tone={status.tone}>{status.label}</StatusBadge>,
    },
    {label: 'Category', value: file.category?.name ?? 'None (deleted)'},
    ...(file.kind === 'pdf'
      ? [
          {
            label: 'Pages',
            value: file.pagesTotal ? String(file.pagesTotal) : '—',
          },
          {label: 'AI cost', value: money(file.costCents)},
        ]
      : [
          {
            label: 'AI cost',
            value: `${money(file.costCents)} (read on this site)`,
          },
        ]),
    {label: 'Uploaded by', value: file.uploadedBy},
    {label: 'Uploaded', value: when(file.createdAt)},
    ...(file.completedAt ? [{label: 'Finished', value: when(file.completedAt)}] : []),
  ];
  const note = file.error || (file.state === 'failed' && file.couldNotRead ? KB_FILE_MESSAGES.couldNotRead : '');
  return (
    <div className="form-stack">
      {/* Read out as a PDF moves page by page (the drawer follows it every 4 s). */}
      <p className="visually-hidden" role="status">
        {status.label}
      </p>
      <DefinitionList items={items} />
      {note && (
        <Notice tone={file.state === 'failed' ? 'danger' : 'info'} title={file.state === 'failed' ? status.label : 'Note'}>
          {note}
        </Notice>
      )}
      <section className="screen-files-drafts" aria-labelledby="files-drafts-title">
        <h3 id="files-drafts-title">Drafts from this file</h3>
        {file.drafts.length ? (
          <ul>
            {file.drafts.map(draft => (
              <li key={draft.id}>
                <Link to="/articles" search={{edit: draft.id}}>
                  {draft.title}
                </Link>
                <StatusBadge tone={ARTICLE_STATUS_TONES[draft.status]}>{ARTICLE_STATUS_LABELS[draft.status]}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {isActive(file) || file.state === 'uploading'
              ? 'Drafts appear here when the file has been read.'
              : file.state === 'drafted'
                ? 'No drafts are left from this file.'
                : 'No drafts were made.'}
          </p>
        )}
      </section>
      <Notice tone="warning">{REVIEW_NOTE}</Notice>
    </div>
  );
}

// ------------------------------------------------------------------ retry --

/** "Try again": read a failed or cancelled file again, in the same or another category. */
function RetryModal({
  file,
  pdfReady,
  onClose,
  onDone,
}: {
  file: KbFileRow | null;
  pdfReady: boolean | undefined;
  onClose: () => void;
  onDone: (file: KbFileRow) => void;
}) {
  const queryClient = useQueryClient();
  const categories = useQuery({...kbCategoriesQuery, enabled: file !== null});
  const list = categories.data?.categories ?? [];
  const [categoryId, setCategoryId] = useState('');
  const [tried, setTried] = useState(false);
  const retry = useMutation({
    mutationFn: ({row, category}: {row: KbFileRow; category: number}) =>
      read<{file: KbFileRow}>(
        api.kb.files[':id'].retry.$post({
          param: {id: String(row.id)},
          json: {categoryId: category === row.category?.id ? null : category},
        })
      ),
    onSuccess: (_res, {row}) => onDone(row),
    // Refused (changed meanwhile, tried too often): the list shows the file as it is now.
    onError: () => queryClient.invalidateQueries({queryKey: ['kb', 'files', 'list']}),
  });
  useEffect(() => {
    if (!file) return;
    setCategoryId(file.category ? String(file.category.id) : '');
    setTried(false);
    retry.reset();
  }, [file?.id]);

  if (!file) return <Modal open={false} onClose={onClose} title="Try again" />;
  const pdfBlocked = file.kind === 'pdf' && pdfReady === false;
  const categoryError = tried && !categoryId ? KB_FILE_MESSAGES.category : undefined;
  const busy = retry.isPending;
  const go = () => {
    setTried(true);
    if (!categoryId || pdfBlocked) {
      if (!categoryId) document.getElementById('f-retry-category')?.focus();
      return;
    }
    retry.mutate({row: file, category: Number(categoryId)});
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      title={`Read “${file.name}” again?`}
      description="It is read from the start. Drafts already made from it stay in Articles."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button icon="refresh" pending={busy} pendingLabel="Starting…" disabled={pdfBlocked} onClick={go}>
            Try again
          </Button>
        </>
      }>
      <div className="form-stack">
        {pdfBlocked && <Notice tone="warning">{KB_FILE_MESSAGES.pdfNeedsAi}</Notice>}
        {categories.error ? (
          <ErrorNote title="The categories could not load" error={categories.error} />
        ) : (
          <Field id="f-retry-category" label="Category for the drafts" error={categoryError}>
            <Select
              id="f-retry-category"
              value={categoryId}
              disabled={busy || categories.isPending}
              aria-invalid={categoryError ? true : undefined}
              aria-describedby={categoryError ? 'f-retry-category-error' : undefined}
              onChange={event => setCategoryId(event.target.value)}
              options={[
                {
                  value: '',
                  label: categories.isPending ? 'Loading…' : 'Choose a category',
                },
                ...list.map(c => ({value: String(c.id), label: c.name})),
              ]}
            />
          </Field>
        )}
        {retry.error && (
          <p className="field-error" role="alert">
            {actionErrorText(retry.error, 'retry')}
          </p>
        )}
      </div>
    </Modal>
  );
}
