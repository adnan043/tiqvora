import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import type {Agent, CannedReply, SourceLink, StaffTicket, SuggestReply, ThreadMessage, TicketPriority, TicketStatus} from '../../../lib/helpdesk-tickets';
import {TICKET_LIMITS} from '../../../lib/helpdesk-tickets';
import {type Confidence, PRIORITY_LABELS, TICKET_STATUS_LABELS, TICKET_STATUS_TONES} from '../../../lib/helpdesk-tones';
import {api, ApiError, read} from '../../api';
import {inboxAgentsQuery, inboxThreadQuery, inboxTicketQuery, inboxViewersQuery} from '../../queries';
import {ago, useMe, when} from '../../shared';
import {
  Badge,
  Button,
  Card,
  ChatMessage,
  CitationList,
  Composer,
  type ComposerHandle,
  type ComposerMode,
  ConfidenceBadge,
  Drawer,
  EmptyState,
  ErrorNote,
  Icon,
  IconButton,
  LoadingBlock,
  Menu,
  type MenuItem,
  Notice,
  Select,
  Skeleton,
  StatusBadge,
  TicketMeta,
  TimelineEvent,
  useConfirm,
  useToast,
} from '../../ui';
import {fillPlaceholders, SavedRepliesModal} from './saved-replies';

const STATUS_OPTIONS = (['waiting', 'open', 'pending', 'solved'] as const).map(value => ({value, label: TICKET_STATUS_LABELS[value]}));
const PRIORITY_ONLY = (['urgent', 'high', 'normal', 'low'] as const).map(value => ({value, label: PRIORITY_LABELS[value]}));
const CONFIDENCES = new Set<string>(['high', 'medium', 'low', 'none']);
/** A summary longer than this is clamped to three lines with "Show more". */
const SUMMARY_CLAMP_FROM = 220;
/** The ticket query polls for the summary this long after the hand-off (queries.ts), then stops. */
const SUMMARY_WAIT_MS = 2 * 60_000;

/** The status a reply leaves the ticket in (the server's `setStatus`; default Pending). */
type AfterSend = 'pending' | 'open' | 'solved';
const AFTER_SEND_OPTIONS: {value: AfterSend; label: string}[] = [
  {value: 'pending', label: 'Set Pending'},
  {value: 'open', label: 'Keep Open'},
  {value: 'solved', label: 'Mark Solved'},
];
const REPLY_HINTS: Record<AfterSend, string> = {
  pending: 'The customer sees your reply in My support. Sending sets the ticket to Pending.',
  open: 'The customer sees your reply in My support. The ticket stays Open.',
  solved: 'The customer sees your reply in My support. Sending marks the ticket Solved.',
};
const NOTE_HINT = 'Only your team sees notes. Suggest reply works for replies.';
/** The hand-off's assistant lines are what the customer's browser sent: shown as such. */
const AI_COPY_LABEL = "Assistant (customer's copy, not verified)";

const CHANGED = "Someone else changed this ticket. It's been refreshed.";
const NO_ACCESS = 'You no longer have access to the inbox.';

/** What "Suggest reply" left under the composer: the draft's sources, or why there is none. */
type Suggestion = {kind: 'ready'; citations: SourceLink[]; confidence: 'high' | 'medium' | 'low'} | {kind: 'no_source'};

const NO_SOURCE_TEXT = 'No published article covers this. Write the reply yourself.';

/** What a suggested draft is, in words: shown under the box and announced once. */
function draftAddedText(n: number, confidence: 'high' | 'medium' | 'low'): string {
  return (
    `Draft added to the reply from ${n} ${n === 1 ? 'article' : 'articles'}. Check it before sending.` +
    (confidence === 'low' ? ' The assistant is not sure it answers the question.' : '')
  );
}

/** "Suggest reply" failing, in words, next to the button (by the server's `code`, never its text). */
export function describeSuggestError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ai_off') return 'Suggest reply needs the assistant: add an AI key and a monthly budget in Assistant settings.';
    if (err.code === 'ai_cap') return "This month's AI budget is used up. Write the reply yourself.";
    if (err.code === 'rate_limited' || err.status === 429) return 'Too many suggestions in a minute. Wait a moment and try again.';
    if (err.code === 'ai_failed') return "The assistant couldn't write a draft this time. Try again, or write the reply yourself.";
    if (err.status === 404) return 'This ticket no longer exists.';
    if (err.status === 403) return NO_ACCESS;
  }
  return "Couldn't get a suggestion. Check your connection and try again.";
}

/** Message ids are BigInts as strings: a longer id is a newer one. */
const byId = (a: ThreadMessage, b: ThreadMessage) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "Sam is also viewing", "Sam and Priya are also viewing", "Sam and 2 others are also viewing". */
export function viewingText(others: {name: string}[]): string {
  const [a, b] = others;
  if (!a) return '';
  if (others.length === 1) return `${a.name} is also viewing`;
  if (others.length === 2) return `${a.name} and ${b!.name} are also viewing`;
  return `${a.name} and ${others.length - 1} others are also viewing`;
}

type Change =
  | {field: 'status'; from: TicketStatus; to: TicketStatus; confirmed?: boolean}
  | {field: 'priority'; from: TicketPriority; to: TicketPriority}
  | {field: 'assignee'; from: number | null; to: number | null; name?: string};

const FIELD_WORDS = {status: 'status', priority: 'priority', assignee: 'assignee'} as const;

function describeChangeError(err: unknown, field: Change['field']): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return CHANGED;
    if (err.status === 403) return NO_ACCESS;
    if (err.status === 422) return err.message;
  }
  return `Couldn't change the ${FIELD_WORDS[field]}. Try again.`;
}

function describeSendError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Someone changed this ticket. Read the latest, then send again.';
    if (err.status === 403) return NO_ACCESS;
    if (err.status === 422) return err.message;
    if (err.status === 404) return 'This ticket no longer exists.';
  }
  return "Your reply wasn't sent. Check your connection and try again.";
}

/**
 * The picked ticket: the thread pane (head, AI summary, conversation,
 * composer) and its details, in the 300px pane when `wide`, else in a Drawer.
 * Rendered as siblings inside `.screen-inbox-panes`. One instance per ticket
 * (`key={number}`), so drafts, older pages and busy states never leak across.
 */
export function TicketView({
  number,
  wide,
  focusTitle,
  onTitleFocused,
  onBack,
  onClose,
  mode,
  onModeChange,
  composerRef,
  drafts,
  announce,
}: {
  number: number;
  wide: boolean;
  /** Move focus to the thread's heading once it renders (a pick on a phone). */
  focusTitle: boolean;
  onTitleFocused: () => void;
  /** Phones: back to the list. */
  onBack: () => void;
  /** Leave this ticket (it was deleted, or does not exist). */
  onClose: () => void;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  composerRef: RefObject<ComposerHandle | null>;
  drafts: Map<number, string>;
  announce: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const me = useMe();
  const myId = me.data?.viewer.id ?? null;
  const myName = me.data?.viewer.name ?? '';

  // Refetches every 10 s while the AI summary is being written (queries.ts).
  const ticketQuery = useQuery(inboxTicketQuery(number));
  const t = ticketQuery.data?.ticket;
  const presence = useQuery({...inboxViewersQuery(number), enabled: ticketQuery.isSuccess});
  const agents = useQuery(inboxAgentsQuery);

  // Someone else replied or changed the ticket since it loaded: read it again.
  useEffect(() => {
    const p = presence.data;
    if (!p || !t) return;
    if (p.status !== t.status || Date.parse(p.lastMessageAt) > Date.parse(t.lastMessageAt)) {
      void queryClient.invalidateQueries({queryKey: ['helpdesk', 'ticket', number], exact: true});
    }
  }, [presence.data, t, number, queryClient]);

  // After a change: the lists, the counts and this ticket. Not the agents, the saved replies or reports.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({queryKey: ['helpdesk', 'tickets']}),
      queryClient.invalidateQueries({queryKey: ['helpdesk', 'stats']}),
      queryClient.invalidateQueries({queryKey: ['helpdesk', 'ticket', number], exact: true}),
    ]);

  // ------------------------------------------------------------ details --
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (wide) setDetailsOpen(false);
  }, [wide]);
  const [fieldError, setFieldError] = useState<{tone: 'danger' | 'info'; text: string} | null>(null);
  const assigneeSelect = useRef<HTMLElement | null>(null);

  const change = useMutation({
    mutationFn: (c: Change) => {
      const param = {number: String(number)};
      if (c.field === 'status') return read(api.helpdesk.tickets[':number'].status.$post({param, json: {from: c.from, to: c.to}}));
      if (c.field === 'priority') return read(api.helpdesk.tickets[':number'].priority.$post({param, json: {from: c.from, to: c.to}}));
      return read(api.helpdesk.tickets[':number'].assignee.$post({param, json: {from: c.from, to: c.to}}));
    },
    onMutate: () => setFieldError(null),
    onSuccess: (_res, c) => {
      if (c.field === 'status') toast.success(c.to === 'solved' ? `Ticket #${number} marked solved.` : `Status set to ${TICKET_STATUS_LABELS[c.to]}.`);
      else if (c.field === 'priority') toast.success(`Priority set to ${PRIORITY_LABELS[c.to]}.`);
      else toast.success(c.to === null ? 'Unassigned.' : c.to === myId ? 'Assigned to you.' : `Assigned to ${c.name ?? 'them'}.`);
      return refresh();
    },
    onError: (err, c) => {
      const text = describeChangeError(err, c.field);
      if (err instanceof ApiError && err.status === 409) void refresh();
      // A change made from the confirm dialog shows its error there.
      if (!(c.field === 'status' && c.confirmed)) setFieldError({tone: text === CHANGED ? 'info' : 'danger', text});
    },
  });
  const busy = change.isPending ? change.variables.field : null;

  const remove = useMutation({
    mutationFn: () => read(api.helpdesk.tickets[':number'].$delete({param: {number: String(number)}})),
  });

  const confirmSolve = (from: TicketStatus) => {
    const first = firstName(t?.customer.name ?? 'The customer');
    void confirm({
      tone: 'primary',
      title: `Mark ticket #${number} solved?`,
      body: `${first} sees it's solved in My support, with a request to rate our help. If ${first} replies, the ticket opens again.`,
      confirmLabel: 'Mark solved',
      pendingLabel: 'Saving…',
      action: () =>
        change.mutateAsync({field: 'status', from, to: 'solved', confirmed: true}).catch((err: unknown) => {
          throw new Error(describeChangeError(err, 'status'));
        }),
    });
  };
  const changeStatus = (to: TicketStatus) => {
    if (!t || to === t.status) return;
    if (to === 'solved') return confirmSolve(t.status);
    change.mutate({field: 'status', from: t.status, to});
  };
  const changeAssignee = (to: number | null) => {
    if (!t || to === (t.assignee?.id ?? null)) return;
    const name = to === null ? undefined : (agents.data?.agents.find(a => a.id === to)?.name ?? t.assignee?.name);
    change.mutate({field: 'assignee', from: t.assignee?.id ?? null, to, name});
  };
  const assignMe = () => {
    if (myId === null || !t) return;
    change.mutate(
      {field: 'assignee', from: t.assignee?.id ?? null, to: myId},
      // The button disappears on success: focus goes to the Assignee select.
      {onSuccess: () => requestAnimationFrame(() => assigneeSelect.current?.querySelector('select')?.focus())}
    );
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/dashboard/inbox?ticket=${number}`);
      toast.success('Link copied.');
    } catch {
      toast.danger("Couldn't copy. Copy it from the address bar.");
    }
  };
  const askDelete = () =>
    void confirm({
      title: `Delete ticket #${number}?`,
      body: `Delete ticket #${number} and its whole conversation? This can't be undone.`,
      confirmLabel: 'Delete ticket',
      pendingLabel: 'Deleting…',
      action: () =>
        remove.mutateAsync().catch((err: unknown) => {
          throw new Error(err instanceof ApiError && err.status === 403 ? 'You may not delete tickets.' : "Couldn't delete the ticket. Try again.");
        }),
    }).then(ok => {
      if (!ok) return;
      toast.success(`Ticket #${number} deleted.`);
      queryClient.removeQueries({queryKey: ['helpdesk', 'ticket', number]});
      void refresh();
      onClose();
    });

  // ------------------------------------------------------------ thread --
  const [older, setOlder] = useState<{messages: ThreadMessage[]; next: string | null} | null>(null);
  const loadOlder = useMutation({
    mutationFn: (before: string) => queryClient.fetchQuery(inboxThreadQuery(number, before)),
    onSuccess: page => {
      setOlder(current => ({messages: [...(current?.messages ?? []), ...page.messages], next: page.nextBefore}));
      // The button goes away with the last page: keep focus in the conversation.
      if (!page.nextBefore) requestAnimationFrame(() => scroller.current?.focus());
    },
  });
  const moreBefore = older ? older.next : (t?.thread.nextBefore ?? null);

  // Oldest first, without repeats (a refetch can overlap an older page).
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const all = [...(older?.messages ?? []), ...(t?.thread.messages ?? [])];
    return all.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true))).sort(byId);
  }, [older, t?.thread.messages]);

  const scroller = useRef<HTMLDivElement>(null);
  const newestId = messages.at(-1)?.id;
  // A new newest message (the first load, a reply, a refetch): show the bottom of the thread.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newestId]);

  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle && t && titleRef.current) {
      titleRef.current.focus();
      onTitleFocused();
    }
  }, [focusTitle, t, onTitleFocused]);

  // ------------------------------------------------------------ composer --
  const [sendError, setSendError] = useState<string | undefined>();
  const keys = useRef(new Map<string, string>());
  const keyFor = (text: string, kind: ComposerMode) => {
    const name = `${kind}:${text}`;
    let key = keys.current.get(name);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(name, key);
    }
    return key;
  };
  const [afterSend, setAfterSend] = useState<AfterSend>('pending');
  const send = useMutation({
    mutationFn: ({text, kind, expectedStatus, setStatus}: {text: string; kind: ComposerMode; expectedStatus: TicketStatus; setStatus?: AfterSend; confirmed?: boolean}) =>
      read<{message: ThreadMessage; status: TicketStatus}>(
        api.helpdesk.tickets[':number'].messages.$post({
          param: {number: String(number)},
          json: {kind, body: text, key: keyFor(text, kind), expectedStatus, ...(kind === 'reply' && setStatus ? {setStatus} : {})},
        })
      ),
    onMutate: () => setSendError(undefined),
    onSuccess: (res, vars) => {
      keys.current.delete(`${vars.kind}:${vars.text}`);
      drafts.delete(number);
      queryClient.setQueryData(inboxTicketQuery(number).queryKey, old =>
        old
          ? {
              ticket: {
                ...old.ticket,
                status: res.status,
                lastMessageAt: vars.kind === 'reply' ? res.message.createdAt : old.ticket.lastMessageAt,
                thread: {...old.ticket.thread, messages: [res.message, ...old.ticket.thread.messages]},
              },
            }
          : old
      );
      if (vars.kind === 'reply') setSuggestion(null);
      if (vars.kind === 'reply' && vars.setStatus === 'solved') toast.success(`Reply sent. Ticket #${number} marked solved.`);
      else announce(vars.kind === 'note' ? 'Note added.' : 'Reply sent.');
      setAfterSend('pending');
      return refresh();
    },
    onError: (err, vars) => {
      // A send made from the confirm dialog shows its error there.
      if (!vars.confirmed) setSendError(describeSendError(err));
      if (err instanceof ApiError && err.status === 409) void refresh();
    },
  });
  /** Composer's onSend: rejects to keep the text (a failed send, or the solve dialog cancelled). */
  const sendMessage = async (text: string, kind: ComposerMode, expectedStatus: TicketStatus) => {
    if (kind === 'note') return send.mutateAsync({text, kind, expectedStatus});
    if (afterSend !== 'solved') return send.mutateAsync({text, kind, expectedStatus, setStatus: afterSend});
    const first = firstName(t?.customer.name ?? 'The customer');
    const ok = await confirm({
      tone: 'primary',
      title: `Send and mark ticket #${number} solved?`,
      body: `${first} gets your reply and sees the ticket is solved in My support, with a request to rate our help. If ${first} replies, the ticket opens again.`,
      confirmLabel: 'Send and mark solved',
      pendingLabel: 'Sending…',
      action: () =>
        send.mutateAsync({text, kind, expectedStatus, setStatus: 'solved', confirmed: true}).catch((err: unknown) => {
          throw new Error(describeSendError(err));
        }),
    });
    if (!ok) throw new Error('Not sent.');
  };

  const [repliesOpen, setRepliesOpen] = useState(false);
  const focusComposerAfterClose = useRef(false);
  useEffect(() => {
    if (!repliesOpen && focusComposerAfterClose.current) {
      focusComposerAfterClose.current = false;
      // After the dialog has handed focus back to its trigger: take it to the box.
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [repliesOpen, composerRef]);
  const pickReply = (reply: CannedReply) => {
    composerRef.current?.insert(fillPlaceholders(reply.body, {customer: t?.customer.name ?? '', agent: myName}));
    focusComposerAfterClose.current = true;
    setRepliesOpen(false);
  };

  // ------------------------------------------------------------ suggest --
  // Never sends anything: the draft only goes INTO the composer, at the caret; the agent reads,
  // edits and presses Send (the suggest route has no write path to the thread).
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestError, setSuggestError] = useState<string | undefined>();
  const modeNow = useRef(mode);
  modeNow.current = mode;
  // Suggest reply is for replies: switching to Note clears its last error (it is about a reply).
  useEffect(() => {
    if (mode === 'note') setSuggestError(undefined);
  }, [mode]);
  const suggest = useMutation({
    mutationFn: (requested: number) =>
      read<SuggestReply>(api.helpdesk.tickets[':number'].suggest.$post({param: {number: String(requested)}, json: {mode: 'reply'}})),
    onMutate: () => {
      setSuggestError(undefined);
      setSuggestion(null);
    },
  });
  // The outcome is handled in mutate()'s own callbacks, which never run once this view has
  // unmounted: `composerRef` is the inbox's, so after a switch it points at ANOTHER ticket's box.
  // The ticket asked for is checked too, so a draft only ever lands in its own ticket's reply.
  const requestSuggestion = () =>
    suggest.mutate(number, {
      onSuccess: (res, requested) => {
        if (requested !== number) return;
        if (res.status === 'no_source') {
          setSuggestion({kind: 'no_source'});
          announce(NO_SOURCE_TEXT);
          return;
        }
        // Switched to Note while it was being written: never put a customer reply into a note.
        if (modeNow.current !== 'reply') return setSuggestError('The draft was not added because you switched to Note. Switch to Reply and try again.');
        composerRef.current?.insert(fillPlaceholders(res.reply, {customer: t?.customer.name ?? '', agent: myName}));
        setSuggestion({kind: 'ready', citations: res.citations, confidence: res.confidence});
        announce(draftAddedText(res.citations.length, res.confidence));
      },
      onError: err => setSuggestError(describeSuggestError(err)),
    });

  // ------------------------------------------------------------ render --
  if (ticketQuery.isPending) {
    return (
      <section className="screen-inbox-thread" aria-labelledby="inbox-thread-title" aria-busy="true">
        <div className="screen-inbox-thread-head">
          <IconButton className="screen-inbox-back" icon="arrow-left" label="Back to tickets" onClick={onBack} />
          <div className="screen-inbox-title">
            <h2 id="inbox-thread-title" className="visually-hidden">
              Ticket #{number}
            </h2>
            <Skeleton width="half" />
          </div>
        </div>
        <div className="screen-inbox-thread-state">
          <LoadingBlock rows={4} />
        </div>
      </section>
    );
  }
  if (!t) {
    const missing = ticketQuery.error instanceof ApiError && ticketQuery.error.status === 404;
    return (
      <section className="screen-inbox-thread" aria-labelledby="inbox-thread-title">
        <div className="screen-inbox-thread-head">
          <IconButton className="screen-inbox-back" icon="arrow-left" label="Back to tickets" onClick={onBack} />
          <div className="screen-inbox-title">
            <h2 id="inbox-thread-title">Ticket #{number}</h2>
          </div>
        </div>
        <div className="screen-inbox-thread-state">
          {missing ? (
            <EmptyState
              icon="search"
              title="This ticket does not exist"
              action={
                <Button variant="secondary" onClick={onClose}>
                  Back to the inbox
                </Button>
              }>
              The link may be wrong, or the ticket was deleted.
            </EmptyState>
          ) : (
            <>
              <ErrorNote title="This ticket could not load" error={ticketQuery.error ?? new Error('Something went wrong.')} />
              <Button variant="secondary" icon="refresh" onClick={() => void ticketQuery.refetch()} pending={ticketQuery.isFetching} pendingLabel="Trying…">
                Try again
              </Button>
            </>
          )}
        </div>
      </section>
    );
  }

  const customerFirst = firstName(t.customer.name);
  const others = presence.data?.others ?? [];
  const hasTranscript = messages.some(m => m.sender === 'ai');
  const lastAiIndex = messages.reduce((at, m, i) => (m.sender === 'ai' ? i : at), -1);
  const latestAi = [...messages].reverse().find(m => m.sender === 'ai' && m.confidence && CONFIDENCES.has(m.confidence));
  const confidence = (latestAi?.confidence as Confidence | undefined) ?? null;
  const canDelete = me.data?.abilities.deleteTickets === true;

  const pendingStatus = change.isPending && change.variables.field === 'status' ? change.variables.to : null;
  const pendingPriority = change.isPending && change.variables.field === 'priority' ? change.variables.to : null;
  const pendingAssignee = change.isPending && change.variables.field === 'assignee' ? change.variables.to : undefined;

  const agentList: Agent[] = agents.data?.agents ?? [];
  const assigneeOptions = [
    {value: '', label: 'Nobody'},
    ...(myId !== null ? [{value: String(myId), label: myName ? `Me (${myName})` : 'Me'}] : []),
    ...agentList.filter(a => a.id !== myId).map(a => ({value: String(a.id), label: a.name})),
    ...(t.assignee && t.assignee.id !== myId && !agentList.some(a => a.id === t.assignee!.id)
      ? [{value: String(t.assignee.id), label: `${t.assignee.name} (no longer an agent)`}]
      : []),
  ];

  const details: ReactNode = (
    <div className="screen-inbox-details-body">
      <TicketMeta
        number={t.number}
        status={t.status}
        priority={t.priority}
        assignee={t.assignee?.name ?? null}
        customer={{name: t.customer.name, detail: t.customer.id === null ? 'Account deleted' : undefined}}
        created={when(t.createdAt)}
        label="Status and assignment"
        controls={{
          status: (
            <Select
              aria-label="Status"
              value={pendingStatus ?? t.status}
              disabled={busy !== null}
              onChange={event => changeStatus(event.target.value as TicketStatus)}
              options={STATUS_OPTIONS}
            />
          ),
          priority: (
            <Select
              aria-label="Priority"
              value={pendingPriority ?? t.priority}
              disabled={busy !== null}
              onChange={event => {
                const to = event.target.value as TicketPriority;
                if (to !== t.priority) change.mutate({field: 'priority', from: t.priority, to});
              }}
              options={PRIORITY_ONLY}
            />
          ),
          assignee: (
            <span
              className="screen-inbox-assignee"
              ref={node => {
                assigneeSelect.current = node;
              }}>
              <Select
                aria-label="Assignee"
                value={pendingAssignee !== undefined ? (pendingAssignee === null ? '' : String(pendingAssignee)) : t.assignee ? String(t.assignee.id) : ''}
                disabled={busy !== null}
                onChange={event => changeAssignee(event.target.value ? Number(event.target.value) : null)}
                options={assigneeOptions}
              />
            </span>
          ),
        }}
        extra={[
          {label: 'Came from', value: t.pagePath ? <span className="ticket-page">{t.pagePath}</span> : 'Chat'},
          ...(t.language ? [{label: 'Language', value: t.language}] : []),
          ...(t.csat !== null ? [{label: 'Rating', value: `${t.csat} out of 5`}] : []),
        ]}
      />
      {!t.assignee && myId !== null && (
        <Button variant="secondary" block icon="user" pending={busy === 'assignee'} pendingLabel="Assigning…" disabled={busy !== null} onClick={assignMe}>
          Assign to me
        </Button>
      )}
      {agents.error && <Notice tone="danger">The team list could not load.</Notice>}
      {fieldError && <Notice tone={fieldError.tone}>{fieldError.text}</Notice>}
    </div>
  );

  const menuItems: MenuItem[] = [
    {label: 'Assign to me', icon: 'user', onSelect: assignMe, disabled: myId === null || t.assignee?.id === myId || busy !== null},
    t.status === 'solved'
      ? {label: 'Reopen', icon: 'refresh', onSelect: () => changeStatus('open'), disabled: busy !== null}
      : {label: 'Mark solved', icon: 'check-circle', onSelect: () => confirmSolve(t.status), disabled: busy !== null},
    'separator',
    {label: 'Copy link', icon: 'copy', onSelect: () => void copyLink()},
    ...(canDelete ? (['separator', {label: 'Delete ticket', icon: 'trash', danger: true, onSelect: askDelete}] as MenuItem[]) : []),
  ];

  return (
    <>
      <section className="screen-inbox-thread" aria-labelledby="inbox-thread-title">
        <div className="screen-inbox-thread-head">
          <IconButton className="screen-inbox-back" icon="arrow-left" label="Back to tickets" onClick={onBack} />
          <div className="screen-inbox-title">
            <h2 id="inbox-thread-title" tabIndex={-1} ref={titleRef}>
              <span className="ticket-number">#{t.number}</span> {t.subject}
            </h2>
            <p className="screen-inbox-subtitle">
              <StatusBadge tone={TICKET_STATUS_TONES[t.status]}>{TICKET_STATUS_LABELS[t.status]}</StatusBadge>
              <span>{t.customer.name}</span>
              <span role="status">
                {others.length > 0 && (
                  <Badge tone="info" icon="eye">
                    {viewingText(others)}
                  </Badge>
                )}
              </span>
            </p>
          </div>
          <div className="screen-inbox-thread-actions">
            {!wide && (
              <Button
                className="screen-inbox-details-button"
                variant="secondary"
                size="sm"
                icon="info"
                aria-haspopup="dialog"
                onClick={() => setDetailsOpen(true)}>
                Details
              </Button>
            )}
            <Menu label={`More actions for ticket #${t.number}`} items={menuItems} />
          </div>
        </div>

        <div className="screen-inbox-thread-body" role="log" aria-live="off" aria-label="Conversation" tabIndex={0} ref={scroller}>
          <SummaryCard ticket={t} confidence={confidence} hasTranscript={hasTranscript} />
          {moreBefore && (
            <div className="screen-inbox-older">
              <Button
                variant="ghost"
                size="sm"
                pending={loadOlder.isPending}
                pendingLabel="Loading…"
                onClick={() => loadOlder.mutate(moreBefore)}>
                Show earlier messages
              </Button>
            </div>
          )}
          {loadOlder.error && <Notice tone="danger">Earlier messages could not load. Try again.</Notice>}
          <div className="chat-thread">
            {!moreBefore && messages[0]?.sender === 'ai' && <TimelineEvent>Chat with the assistant before the hand-off</TimelineEvent>}
            {messages.map((m, i) => (
              <ThreadItem key={m.id} message={m} afterHandOff={i === lastAiIndex && i < messages.length - 1} />
            ))}
          </div>
        </div>

        <div className="screen-inbox-composer">
          <Composer
            key={t.number}
            label={`Reply to ${customerFirst}`}
            modes
            mode={mode}
            onModeChange={onModeChange}
            maxLength={TICKET_LIMITS.body}
            placeholder={mode === 'reply' ? 'e.g. Thanks for waiting. Here is what to do…' : 'e.g. Checked the order, refund is on its way.'}
            sendLabel={afterSend === 'solved' ? 'Send and solve' : 'Send reply'}
            pendingLabel={mode === 'note' ? 'Adding…' : 'Sending…'}
            pending={send.isPending}
            error={sendError}
            hint={mode === 'note' ? NOTE_HINT : REPLY_HINTS[afterSend]}
            tools={
              <>
                {mode === 'reply' && (
                  <Select
                    className="screen-inbox-after-send"
                    aria-label="Status after sending"
                    value={afterSend}
                    disabled={send.isPending}
                    onChange={event => setAfterSend(event.target.value as AfterSend)}
                    options={AFTER_SEND_OPTIONS}
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon="sparkles"
                  pending={suggest.isPending}
                  pendingLabel="Drafting…"
                  disabled={mode === 'note' || send.isPending}
                  onClick={requestSuggestion}>
                  Suggest reply
                </Button>
                <Button variant="ghost" size="sm" icon="copy" onClick={() => setRepliesOpen(true)}>
                  Saved replies
                </Button>
              </>
            }
            handle={composerRef}
            initialText={drafts.get(t.number)}
            onTextChange={text => (text ? drafts.set(t.number, text) : drafts.delete(t.number))}
            onSend={(text, kind) => sendMessage(text, kind, t.status)}
          />
          <SuggestionNote
            suggestion={suggestion}
            error={suggestError}
            canWriteArticles={me.data?.abilities.editKnowledge === true}
            onDismiss={() => {
              setSuggestion(null);
              composerRef.current?.focus();
            }}
          />
        </div>
      </section>

      {wide ? (
        <aside className="screen-inbox-details" aria-label="Ticket details">
          {details}
        </aside>
      ) : (
        <Drawer open={detailsOpen} onClose={() => setDetailsOpen(false)} title={`Ticket #${t.number}`} description="Details and assignment">
          {details}
        </Drawer>
      )}

      <SavedRepliesModal open={repliesOpen} onClose={() => setRepliesOpen(false)} onPick={pickReply} />
    </>
  );
}

/**
 * Under the composer: where a suggested draft came from (links open in a new tab, so the draft
 * in the box is never lost), or why there is none, or why it failed. The outcome is also said
 * through the inbox's persistent `announce()` (a Notice that appears with its text is not
 * reliably read); the error is `role="alert"`.
 */
function SuggestionNote({
  suggestion,
  error,
  canWriteArticles,
  onDismiss,
}: {
  suggestion: Suggestion | null;
  error: string | undefined;
  canWriteArticles: boolean;
  onDismiss: () => void;
}) {
  if (error) {
    return (
      <p className="field-error screen-inbox-suggest-error" role="alert">
        {error}
      </p>
    );
  }
  if (!suggestion) return null;
  const dismiss = <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} />;
  if (suggestion.kind === 'no_source') {
    return (
      <div className="screen-inbox-suggest">
        <Notice tone="info" action={dismiss}>
          {NO_SOURCE_TEXT}
          {canWriteArticles && (
            <>
              {' '}
              <Link to="/articles" search={{new: true}}>
                Write an article
              </Link>
            </>
          )}
        </Notice>
      </div>
    );
  }
  return (
    <div className="screen-inbox-suggest">
      <Notice tone={suggestion.confidence === 'low' ? 'warning' : 'info'} action={dismiss}>
        <p>{draftAddedText(suggestion.citations.length, suggestion.confidence)}</p>
        <CitationList title="Based on" newTab items={suggestion.citations.map(c => ({title: c.title, href: c.url}))} />
      </Notice>
    </div>
  );
}

function ThreadItem({message: m, afterHandOff}: {message: ThreadMessage; afterHandOff: boolean}) {
  return (
    <>
      <ChatMessage
        sender={m.sender}
        author={m.sender === 'ai' ? AI_COPY_LABEL : (m.author ?? undefined)}
        time={ago(m.createdAt)}
        dateTime={m.createdAt}
        footer={m.citations.length ? <CitationList items={m.citations.map(c => ({title: c.title, href: c.url}))} /> : undefined}>
        {m.body}
      </ChatMessage>
      {afterHandOff && <TimelineEvent>Asked for a person</TimelineEvent>}
    </>
  );
}

function SummaryCard({ticket: t, confidence, hasTranscript}: {ticket: StaffTicket; confidence: Confidence | null; hasTranscript: boolean}) {
  const [expanded, setExpanded] = useState(false);
  const long = (t.aiSummary?.length ?? 0) > SUMMARY_CLAMP_FROM;
  // Polling stops 2 minutes after the hand-off: past that, say so instead of a skeleton forever.
  const waitLeft = Date.parse(t.createdAt) + SUMMARY_WAIT_MS - Date.now();
  const [slow, setSlow] = useState(waitLeft <= 0);
  useEffect(() => {
    if (t.aiSummaryState !== 'pending' || slow) return;
    const timer = setTimeout(() => setSlow(true), Math.max(0, waitLeft));
    return () => clearTimeout(timer);
  }, [t.aiSummaryState, slow, waitLeft]);
  const sources = t.aiSources.map(s => ({title: s.title, href: s.url}));
  return (
    <Card
      className="screen-inbox-summary"
      title="AI summary"
      description={t.aiSummaryState === 'unavailable' ? undefined : 'Written by the assistant from the chat. Check it against the conversation.'}
      actions={confidence ? <ConfidenceBadge confidence={confidence} /> : undefined}>
      {t.aiSummaryState === 'pending' ? (
        slow ? (
          <p className="muted">Still working — check back in a few minutes.</p>
        ) : (
          <div className="screen-inbox-summary-pending" role="status">
            <Skeleton lines={2} />
            <p className="muted">Writing a summary…</p>
          </div>
        )
      ) : t.aiSummaryState === 'ready' && t.aiSummary ? (
        <>
          <p className="screen-inbox-summary-text" data-open={expanded || !long ? '' : undefined}>
            {t.aiSummary}
          </p>
          {long && (
            <Button variant="link" size="sm" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}
        </>
      ) : (
        <p className="muted">No AI summary. Add an AI key in Assistant settings to get summaries.</p>
      )}
      <CitationList title="Articles the customer was shown" items={sources} />
      {sources.length === 0 && hasTranscript && t.aiSummaryState !== 'unavailable' && <p className="muted">The assistant showed no articles.</p>}
    </Card>
  );
}
