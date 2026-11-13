import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useParams} from '@tanstack/react-router';
import {type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {CUSTOMER_STATUS_LABELS, type MyTicket, type MyTicketRow, type ThreadMessage, TICKET_LIMITS} from '../../lib/helpdesk-tickets';
import {TICKET_STATUS_TONES, type TicketStatus} from '../../lib/helpdesk-tones';
import {api, ApiError, read} from '../api';
import {supportTicketQuery, supportTicketsQuery, supportUnreadQuery} from '../queries';
import {ago, when} from '../shared';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  ChatMessage,
  CitationList,
  type Column,
  Composer,
  type ComposerHandle,
  DataTable,
  DefinitionList,
  EmptyState,
  ErrorNote,
  Icon,
  LoadingBlock,
  LoadMore,
  Notice,
  PageHeader,
  RatingScale,
  StatusBadge,
  useConfirm,
} from '../ui';

/**
 * "My support": a signed-in customer's own requests (the customer never reads
 * the word "ticket"). The server scopes every read and write to the viewer and
 * never sends internal notes, the AI summary or sources, the priority or who
 * the ticket is assigned to (src/server/routes/support.ts): this screen shows
 * what it is given and adds nothing staff-only.
 */

const CustomerStatus = ({status}: {status: TicketStatus}) => (
  <StatusBadge tone={TICKET_STATUS_TONES[status]}>{CUSTOMER_STATUS_LABELS[status]}</StatusBadge>
);

// ------------------------------------------------------------------- list --

const COLUMNS: Column<MyTicketRow>[] = [
  {
    key: 'request',
    header: 'Request',
    cell: row => (
      <div>
        <Link className="cell-title" to="/support/$ticketId" params={{ticketId: String(row.number)}}>
          <span className="ticket-number">#{row.number}</span> {row.subject}
        </Link>
        {row.unread && (
          <span className="screen-support-unread">
            <Badge tone="brand">New reply</Badge>
          </span>
        )}
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'shrink',
    cell: row => <CustomerStatus status={row.status} />,
  },
  {
    key: 'updated',
    header: 'Last update',
    width: 'shrink',
    cell: row => (
      <time className="muted" dateTime={row.lastMessageAt} title={when(row.lastMessageAt)}>
        {ago(row.lastMessageAt)}
      </time>
    ),
  },
];

/** `/dashboard/support`: every request this account has made, newest first. */
export function Support() {
  const tickets = useInfiniteQuery(supportTicketsQuery);
  const rows = tickets.data?.pages.flatMap(page => page.items);
  return (
    <div className="app-page screen-support">
      <PageHeader
        title="My support"
        description="Your conversations with our support team."
        actions={
          // The help center is a website page: a plain link, not a portal route.
          <a className={buttonClass()} href="/help/">
            Get help
          </a>
        }
      />
      <Card flush>
        <DataTable
          caption="Your requests"
          columns={COLUMNS}
          rows={rows}
          rowKey={row => row.number}
          loading={tickets.isPending}
          error={tickets.error}
          empty={
            <EmptyState
              icon="message-square"
              title="No requests yet"
              action={
                <a className={buttonClass({variant: 'secondary'})} href="/help/">
                  Visit the help center
                </a>
              }>
              Ask the assistant in the help center. When you ask our team for help, the conversation shows here.
            </EmptyState>
          }
        />
      </Card>
      {tickets.error && rows?.length ? <ErrorNote error={tickets.error} /> : null}
      <LoadMore query={tickets} />
    </div>
  );
}

// ---------------------------------------------------------------- request --

const NUMBER_RE = /^\d{1,9}$/;
const SENT_FAILED = "Your message wasn't sent. Check your connection and try again.";
const TOO_MANY = "You've sent a lot of messages. Try again within the hour.";

/** A reply's failure, in words, for the Composer (the text it holds is kept). */
function replyErrorText(error: Error | null): string | undefined {
  if (!error) return undefined;
  if (!(error instanceof ApiError)) return SENT_FAILED;
  if (error.status === 429) return TOO_MANY;
  if (error.status === 422) return error.fields.body ?? error.message;
  if (error.status === 404) return 'This request is no longer there.';
  // 409: closed ("Start a new one…") or changed meanwhile (the screen refetched): the server's words.
  if (error.status === 409) return error.message;
  return SENT_FAILED;
}

/** "This is solved" failing, in words, for the confirm dialog. */
function solveErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This request is no longer there.';
    if (error.status === 409) return 'This request changed meanwhile. Close this and try again.';
    if (error.status === 429) return error.message;
  }
  return "That wasn't saved. Check your connection and try again.";
}

/** "Yes, it's solved" failing, in words, under its button. */
function confirmErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This request is no longer there.';
    if (error.status === 409) return 'This request changed meanwhile. It has been refreshed.';
    if (error.status === 429) return error.message;
  }
  return "That wasn't saved. Check your connection and try again.";
}

/** Messages oldest first, each once: the newest page plus any earlier pages loaded. */
function oldestFirst(...pages: ThreadMessage[][]): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const page of pages) for (const message of page) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The conversation as the customer sees it: their own lines are "You". */
function Thread({messages}: {messages: ThreadMessage[]}) {
  return (
    <div className="chat-thread">
      {messages
        // The server never sends notes to a customer; never draw one if it did.
        .filter(message => message.sender !== 'note')
        .map(message => (
          <ChatMessage
            key={message.id}
            sender={message.sender}
            author={message.sender === 'customer' ? 'You' : message.sender === 'agent' ? (message.author ?? 'Our team') : undefined}
            time={ago(message.createdAt)}
            dateTime={message.createdAt}
            footer={
              message.sender === 'ai' && message.citations.length ? (
                // Keyed by position and URL: an article link's id may be null (never read here).
                <CitationList
                  items={message.citations.map(c => ({
                    title: c.title,
                    href: c.url,
                  }))}
                />
              ) : undefined
            }>
            {message.body}
          </ChatMessage>
        ))}
    </div>
  );
}

type Score = 1 | 2 | 3 | 4 | 5;

/** "How did we do?": once, on a solved request. Score only (the server keeps no comment). */
function CsatCard({number, focusRequest, onRated}: {number: number; focusRequest: number; onRated: (score: Score) => void}) {
  const queryClient = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState<Score | null>(null);
  const [tried, setTried] = useState(false);
  const rate = useMutation({
    mutationFn: (value: Score) =>
      read<{csat: number}>(
        api.helpdesk.my.tickets[':number'].csat.$post({
          param: {number: String(number)},
          json: {score: value},
        }),
      ),
    onSuccess: (_data, value) => {
      onRated(value);
      return queryClient.invalidateQueries({
        queryKey: ['support', 'tickets'],
      });
    },
    onError: error => {
      // Rated meanwhile (another tab): show the saved rating on the next read.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409))
        void queryClient.invalidateQueries({
          queryKey: ['support', 'ticket', number],
        });
    },
  });

  // A `…/support/1042#rate` link, or the customer just marked it solved (`focusRequest` counts
  // up once the confirm dialog has closed): bring the card into view and focus the scale. A frame
  // later, so the dialog handing focus back to its (now gone) trigger can't take it away again.
  useEffect(() => {
    if (focusRequest === 0 && window.location.hash !== '#rate') return;
    const frame = requestAnimationFrame(() => {
      box.current?.scrollIntoView({block: 'center'});
      focusScale();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  function focusScale() {
    const target = box.current?.querySelector<HTMLElement>('[role="radiogroup"] [tabindex="0"], [role="radiogroup"] button');
    target?.focus();
  }

  const scoreError = tried && score === null ? 'Pick a number from 1 to 5.' : undefined;
  const failed =
    rate.error instanceof ApiError && (rate.error.status === 404 || rate.error.status === 409)
      ? "You've already rated this request."
      : rate.error
        ? "Your rating wasn't sent. Check your connection and try again."
        : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (score === null) {
      focusScale();
      return;
    }
    rate.mutate(score);
  };

  return (
    <div id="rate" ref={box}>
      <Card title="How did we do?" description="Your rating goes to our team only.">
        <form className="form-stack" noValidate onSubmit={submit}>
          <RatingScale
            label="Rate our help"
            value={score}
            onChange={value => {
              setScore(value);
              rate.reset();
            }}
            error={scoreError}
            lowLabel="Very poor"
            highLabel="Great"
            disabled={rate.isPending}
          />
          {failed && (
            <p className="field-error" role="alert">
              {failed}
            </p>
          )}
          <div>
            <Button type="submit" pending={rate.isPending} pendingLabel="Sending…">
              Send rating
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** `/dashboard/support/$ticketId`: one request, its conversation, a reply box and a rating once solved. */
export function SupportTicket() {
  const {ticketId = ''} = useParams({strict: false}) as {
    ticketId?: string;
  };
  const valid = NUMBER_RE.test(ticketId);
  const number = valid ? Number(ticketId) : 0;

  const queryClient = useQueryClient();
  const ticket = useQuery({
    ...supportTicketQuery(number),
    enabled: valid,
    // An agent's reply shows without a reload: on focus, and every minute while the tab is visible.
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const t: MyTicket | undefined = ticket.data?.ticket;

  // Earlier messages than the newest page ("Show earlier messages").
  const [older, setOlder] = useState<{
    messages: ThreadMessage[];
    nextBefore: string | null;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [justRated, setJustRated] = useState(false);
  // Counts up when the customer marks the request solved: the rating card then takes focus.
  const [focusRate, setFocusRate] = useState(0);
  // What "Yes, it's solved" did, kept here (not the mutation's isSuccess, which waits for the
  // refetch): the note that replaces its button, and whether it was confirmed.
  const [confirmOutcome, setConfirmOutcome] = useState<{confirmed: boolean; text: string} | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const confirm = useConfirm();
  const thanks = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // One idempotency key per message: a retry of the same text reuses it, so it is never sent twice.
  const pendingKey = useRef<{body: string; key: string} | null>(null);

  useEffect(() => {
    setOlder(null);
    setFocusRate(0);
    setConfirmOutcome(null);
    pendingKey.current = null;
  }, [number]);

  const loadEarlier = useMutation({
    mutationFn: (before: string) =>
      read<{ticket: MyTicket}>(
        api.helpdesk.my.tickets[':number'].$get({
          param: {number: String(number)},
          query: {before},
        }),
      ),
    onSuccess: ({ticket: page}) =>
      setOlder(current => ({
        messages: [...(current?.messages ?? []), ...page.thread.messages],
        nextBefore: page.thread.nextBefore,
      })),
  });

  const reply = useMutation({
    mutationFn: (body: string) => {
      if (pendingKey.current?.body !== body) pendingKey.current = {body, key: crypto.randomUUID()};
      return read<{message: ThreadMessage; status: TicketStatus}>(
        api.helpdesk.my.tickets[':number'].messages.$post({
          param: {number: String(number)},
          json: {body, key: pendingKey.current.key},
        }),
      );
    },
    onSuccess: ({message, status}) => {
      pendingKey.current = null;
      queryClient.setQueryData(supportTicketQuery(number).queryKey, current =>
        current
          ? {
              ...current,
              ticket: {
                ...current.ticket,
                status,
                canRate: current.ticket.canRate && status === 'solved',
                thread: {
                  ...current.ticket.thread,
                  messages: [message, ...current.ticket.thread.messages],
                },
              },
            }
          : current,
      );
      setAnnouncement('Message sent.');
      setConfirmOutcome(null);
      return queryClient.invalidateQueries({queryKey: ['support']});
    },
    onError: error => {
      // Closed or changed meanwhile: read the request again (status, whether it takes replies).
      if (error instanceof ApiError && (error.status === 409 || error.status === 404))
        void queryClient.invalidateQueries({
          queryKey: ['support', 'ticket', number],
        });
    },
  });

  // "This is solved": the customer closes their own request (they can reply later to open it again).
  const solve = useMutation({
    mutationFn: () =>
      read<{status: TicketStatus}>(
        api.helpdesk.my.tickets[':number'].solve.$post({
          param: {number: String(number)},
        }),
      ),
    onSuccess: ({status}) => {
      queryClient.setQueryData(supportTicketQuery(number).queryKey, current =>
        current
          ? {
              ...current,
              // The customer closed it: it counts as confirmed (no "Did it solve your problem?" card).
              ticket: {
                ...current.ticket,
                status,
                resolution: status === 'solved' ? 'confirmed' : current.ticket.resolution,
                canRate: status === 'solved' && current.ticket.csat === null,
              },
            }
          : current,
      );
      setAnnouncement('This request is marked as solved.');
      return queryClient.invalidateQueries({queryKey: ['support']});
    },
    onError: error => {
      // Gone, or changed meanwhile: read the request again.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409))
        void queryClient.invalidateQueries({
          queryKey: ['support', 'ticket', number],
        });
    },
  });

  const markSolved = async () => {
    const solved = await confirm({
      title: 'Mark this request as solved?',
      body: `You can reply later to open it again (within ${TICKET_LIMITS.reopenDays} days).`,
      confirmLabel: 'Mark as solved',
      pendingLabel: 'Saving…',
      tone: 'primary',
      // The dialog shows the thrown message: in words, never a raw network error.
      action: () =>
        solve.mutateAsync().catch((error: unknown) => {
          throw new Error(solveErrorText(error));
        }),
    });
    if (solved) setFocusRate(count => count + 1);
  };

  const confirmedNote = useRef<HTMLParagraphElement>(null);
  // "Yes, it's solved": our team solved it (assumed); the customer agrees, and it counts as confirmed.
  // The same solve route: on a solved request it upgrades the resolution (inside the reopen window).
  // `confirmed` says whether it did: false when it was already confirmed, too old, or reopened meanwhile.
  const confirmSolved = useMutation({
    mutationFn: () =>
      read<{status: TicketStatus; confirmed: boolean}>(
        api.helpdesk.my.tickets[':number'].solve.$post({
          param: {number: String(number)},
        }),
      ),
    onSuccess: ({status, confirmed}) => {
      queryClient.setQueryData(supportTicketQuery(number).queryKey, current =>
        current
          ? {
              ...current,
              ticket: {...current.ticket, status, resolution: confirmed ? 'confirmed' : current.ticket.resolution},
            }
          : current,
      );
      const text = confirmed
        ? 'You told us this is solved. Thank you.'
        : status === 'solved'
          ? 'This request is already solved. Nothing needed changing.'
          : 'This request is open again, so it was not marked as solved. Reply below if you still need help.';
      setConfirmOutcome({confirmed, text});
      setAnnouncement(confirmed ? 'Thanks for confirming.' : text);
      void queryClient.invalidateQueries({queryKey: supportTicketQuery(number).queryKey, exact: true});
    },
    onError: error => {
      // Gone, reopened or changed meanwhile: read the request again.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409))
        void queryClient.invalidateQueries({
          queryKey: ['support', 'ticket', number],
        });
    },
  });

  // The button went away: once the note that replaced it has rendered, it takes focus (else the
  // thanks for a rating). After the commit, never a frame that may run before it.
  useEffect(() => {
    if (confirmOutcome) (confirmedNote.current ?? thanks.current)?.focus();
  }, [confirmOutcome]);

  const messages = useMemo(() => (t ? oldestFirst(older?.messages ?? [], t.thread.messages) : []), [t, older]);
  const newest = messages.at(-1);
  const earlierCursor = older ? older.nextBefore : (t?.thread.nextBefore ?? null);

  // Opening the request (and each new message from the team) clears its "New reply" flag.
  const seen = useMutation({
    mutationFn: () =>
      read(
        api.helpdesk.my.tickets[':number'].seen.$post({
          param: {number: String(number)},
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['support'],
        predicate: query => query.queryKey[1] !== 'ticket',
      }),
  });
  const seenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!t || !newest || seenFor.current === newest.id) return;
    seenFor.current = newest.id;
    // The customer's own line is never "new" to them.
    if (newest.sender === 'customer') return;
    if (!mayBeUnread(newest.createdAt)) return;
    seen.mutate();
    // Only when the newest message changes.
  }, [newest?.id]);

  /**
   * False only when a read that already included the newest message says nothing is unread: the
   * list's row (its last message is at least as new: server times on both sides), or the unread
   * count fetched after this request was (client times on both sides). Anything older can't know.
   */
  function mayBeUnread(newestAt: string): boolean {
    const row = queryClient
      .getQueryData(supportTicketsQuery.queryKey)
      ?.pages.flatMap(page => page.items)
      .find(item => item.number === number);
    if (row && Date.parse(row.lastMessageAt) >= Date.parse(newestAt)) return row.unread;
    const unread = queryClient.getQueryState(supportUnreadQuery.queryKey);
    const loaded = queryClient.getQueryState(supportTicketQuery(number).queryKey)?.dataUpdatedAt ?? Infinity;
    if (unread?.data && unread.dataUpdatedAt >= loaded) return unread.data.count > 0;
    return true;
  }

  // Keep the newest message in view: on open, and when one arrives.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest?.id]);

  useEffect(() => {
    if (justRated) thanks.current?.focus();
  }, [justRated]);

  const rated = (score: Score) => {
    queryClient.setQueryData(supportTicketQuery(number).queryKey, current =>
      current
        ? {
            ...current,
            ticket: {...current.ticket, csat: score, canRate: false},
          }
        : current,
    );
    // The thanks Notice (role="status") says it, and takes focus: no second announcement.
    setJustRated(true);
  };

  const backToList = (
    <Link className={buttonClass({variant: 'secondary'})} to="/support">
      <Icon name="arrow-left" size={18} />
      All requests
    </Link>
  );

  if (!valid || (ticket.error instanceof ApiError && ticket.error.status === 404)) {
    return (
      <div className="app-page screen-support">
        <EmptyState
          icon="search"
          title="We couldn't find this request"
          action={
            <Link className={buttonClass({variant: 'secondary'})} to="/support">
              See your requests
            </Link>
          }>
          It may belong to another account, or the link is wrong.
        </EmptyState>
      </div>
    );
  }
  if (ticket.error && !t) {
    return (
      <div className="app-page screen-support">
        <ErrorNote error={ticket.error} title="This request could not load" />
        <div>
          <Button
            variant="secondary"
            icon="refresh"
            pending={ticket.isFetching}
            pendingLabel="Trying again…"
            onClick={() => void ticket.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!t) {
    return (
      <div className="app-page screen-support">
        <LoadingBlock rows={4} />
      </div>
    );
  }

  const handledBy = [...messages].reverse().find(message => message.sender === 'agent' && message.author)?.author ?? 'Our team';
  const lastUpdate = newest?.createdAt ?? t.createdAt;

  return (
    <div className="app-page screen-support">
      <PageHeader
        title={t.subject}
        description={
          <>
            Request <span className="ticket-number">#{t.number}</span> · opened {when(t.createdAt)}
          </>
        }
        actions={backToList}
      />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="grid-main-side">
        <div className="screen-support-main">
          {t.status === 'pending' && (
            <Notice tone="warning" title="We're waiting for your answer">
              Reply below so we can carry on.
            </Notice>
          )}
          {ticket.error && <ErrorNote error={ticket.error} title="This request could not refresh" />}
          {/* "Did it solve your problem?" first, above the conversation: on a phone the side card
              is at the very bottom, under the thread, the rating and the reply box. */}
          {confirmOutcome && (!confirmOutcome.confirmed || t.status === 'solved') ? (
            <Card>
              <p className="muted screen-support-confirmed" tabIndex={-1} ref={confirmedNote}>
                {confirmOutcome.text}
              </p>
            </Card>
          ) : t.status === 'solved' && t.resolution === 'assumed' && t.canReply ? (
            <Card>
              <div className="screen-support-solve">
                <p>Our team marked this as solved. Did it solve your problem?</p>
                <div className="screen-support-solve-actions">
                  <Button
                    variant="secondary"
                    icon="check-circle"
                    pending={confirmSolved.isPending}
                    pendingLabel="Saving…"
                    onClick={() => confirmSolved.mutate()}>
                    Yes, it's solved
                  </Button>
                  {/* Replying opens it again: take them to the reply box. */}
                  <Button variant="secondary" icon="message-square" disabled={confirmSolved.isPending} onClick={() => composer.current?.focus()}>
                    No, I still need help
                  </Button>
                </div>
                {confirmSolved.error && (
                  <p className="field-error" role="alert">
                    {confirmErrorText(confirmSolved.error)}
                  </p>
                )}
              </div>
            </Card>
          ) : null}
          <Card title="Conversation" flush>
            <div className="screen-support-thread" role="log" aria-live="off" aria-label="Conversation" tabIndex={0} ref={scroller}>
              {earlierCursor && (
                <div className="screen-support-earlier">
                  <Button
                    variant="ghost"
                    size="sm"
                    pending={loadEarlier.isPending}
                    pendingLabel="Loading…"
                    onClick={() => loadEarlier.mutate(earlierCursor)}>
                    Show earlier messages
                  </Button>
                  {loadEarlier.error && (
                    <p className="field-error" role="alert">
                      Earlier messages could not load. Try again.
                    </p>
                  )}
                </div>
              )}
              {messages.length ? <Thread messages={messages} /> : <p className="muted">No messages yet.</p>}
            </div>
          </Card>

          {t.canRate && t.csat === null && <CsatCard number={t.number} focusRequest={focusRate} onRated={rated} />}
          {t.csat !== null && (
            <div className="screen-support-thanks" tabIndex={-1} ref={thanks}>
              <Notice tone="success">Thanks for rating us {t.csat} out of 5.</Notice>
            </div>
          )}

          {t.canReply ? (
            // The Composer is its own bordered box on the card colour: no Card around it (one frame).
            <Composer
              handle={composer}
              label="Reply to our team"
              placeholder="e.g. I tried that, and it still shows the error."
              sendLabel="Send"
              pendingLabel="Sending…"
              maxLength={TICKET_LIMITS.body}
              pending={reply.isPending}
              error={replyErrorText(reply.error)}
              hint={
                t.status === 'solved' ? 'This request is solved. Replying opens it again.' : "Our team's reply shows here."
              }
              onSend={text => {
                setAnnouncement('');
                return reply.mutateAsync(text);
              }}
            />
          ) : (
            <Notice
              tone="info"
              title="This conversation is closed"
              action={
                <a className={buttonClass({variant: 'secondary'})} href="/help/">
                  Get help
                </a>
              }>
              It was solved more than {TICKET_LIMITS.reopenDays} days ago. Ask the assistant in the help center to start a new one.
            </Notice>
          )}
        </div>

        <Card
          title="About this request"
          footer={
            t.status !== 'solved' ? (
              <div className="screen-support-solve">
                <p className="muted">Got what you needed? Let us know and we'll close it.</p>
                <Button variant="secondary" icon="check-circle" pending={solve.isPending} pendingLabel="Saving…" onClick={() => void markSolved()}>
                  This is solved
                </Button>
              </div>
            ) : null
          }>
          <DefinitionList
            items={[
              {
                label: 'Request',
                value: <span className="ticket-number">#{t.number}</span>,
              },
              {label: 'Status', value: <CustomerStatus status={t.status} />},
              {label: 'Handled by', value: handledBy},
              {label: 'Opened', value: when(t.createdAt)},
              {
                label: 'Last update',
                value: (
                  <time dateTime={lastUpdate} title={when(lastUpdate)}>
                    {ago(lastUpdate)}
                  </time>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
