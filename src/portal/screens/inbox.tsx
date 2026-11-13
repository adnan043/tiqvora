import {useInfiniteQuery} from '@tanstack/react-query';
import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';

import type {InboxRow, Queue, TicketPriority} from '../../lib/helpdesk-tickets';
import {PRIORITY_LABELS} from '../../lib/helpdesk-tones';
import {inboxTicketsQuery} from '../queries';
import {ago, useMediaQuery, useMe} from '../shared';
import {
  Button,
  buttonClass,
  type ComposerHandle,
  type ComposerMode,
  ConversationListItem,
  EmptyState,
  ErrorNote,
  type IconName,
  LoadingBlock,
  LoadMore,
  PageHeader,
  SegmentedControl,
  Select,
} from '../ui';
import {TicketView} from './inbox/ticket';

/**
 * `/dashboard/inbox` (holders of `site:helpdesk:inbox`): the tickets customers
 * opened by asking for a person. Three panes from 1281px (list · thread ·
 * details), two below (details in a Drawer), one at a time on phones. The
 * view, the priority filter and the open ticket live in the URL, so a link
 * (`?view=mine&ticket=1042`) opens exactly that state. Layout: src/styles/inbox.css.
 */

const VIEW_OPTIONS: {value: Queue; label: ReactNode}[] = [
  {value: 'waiting', label: <ViewLabel long="Waiting on us" short="Waiting" />},
  {value: 'mine', label: <ViewLabel long="Assigned to me" short="Mine" />},
  {value: 'pending', label: <ViewLabel long="Pending" short="Pending" />},
  {value: 'solved', label: <ViewLabel long="Solved" short="Solved" />},
];

const VIEW_TITLES: Record<Queue, string> = {
  waiting: 'Waiting on us',
  mine: 'Assigned to me',
  pending: 'Pending',
  solved: 'Solved',
};

const PRIORITY_OPTIONS = [
  {value: '', label: 'Any priority'},
  ...(['urgent', 'high', 'normal', 'low'] as const).map(value => ({value, label: PRIORITY_LABELS[value]})),
];

const EMPTY_VIEWS: Record<Queue, {icon: IconName; title: string; body: string}> = {
  waiting: {icon: 'check-circle', title: 'Nothing waiting on you', body: 'New questions from customers show here.'},
  mine: {icon: 'user', title: 'Nothing assigned to you', body: 'Pick a ticket from Waiting on us and assign it to yourself.'},
  pending: {icon: 'clock', title: 'Nothing pending', body: "Tickets waiting on a customer's answer show here."},
  solved: {icon: 'check-circle', title: 'No solved tickets yet', body: 'Tickets you mark solved show here.'},
};

/** Long words on wide screens, short ones on phones; CSS hides one so a screen reader reads one. */
function ViewLabel({long, short}: {long: string; short: string}) {
  return (
    <>
      <span className="view-long">{long}</span>
      <span className="view-short">{short}</span>
    </>
  );
}

/** The server applies the priority filter only to these views (Pending / Solved stay fast). */
const PRIORITY_VIEWS = new Set<Queue>(['waiting', 'mine']);

/** The thread pane with no ticket open and an empty list: what will open here. */
const NO_TICKET_TEXT: Record<Queue, string> = {
  waiting: 'When customers ask for a person, their tickets open here.',
  mine: 'Tickets assigned to you open here.',
  pending: "Tickets waiting on a customer's answer open here.",
  solved: 'Solved tickets open here.',
};

/** Where a single-key shortcut must not fire: typing, a menu, a radio group, a list box, a dialog. */
const SHORTCUT_FREE = 'input, textarea, select, dialog, [role="dialog"], [role="menu"], [role="menuitem"], [role="radiogroup"], [role="listbox"]';

/**
 * Shortcuts never fire while typing (or composing text), with a modifier, inside a control
 * that owns its keys, or when something else already handled the key. They are bound to the
 * panes, not the document, so they only act while focus is in the inbox (WCAG 2.1.4).
 */
function shortcutsBlocked(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return true;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(SHORTCUT_FREE) !== null;
}

export function Inbox() {
  const me = useMe();
  if (me.data?.abilities.useInbox === false) {
    return (
      <div className="app-page screen-inbox-locked">
        <EmptyState
          icon="lock"
          title="The inbox is for your support team"
          action={
            <Link className={buttonClass({variant: 'secondary'})} to="/">
              Back to the overview
            </Link>
          }>
          Ask an admin to give you the Support agent role.
        </EmptyState>
      </div>
    );
  }
  return <InboxScreen />;
}

function InboxScreen() {
  const navigate = useNavigate();
  const search = useSearch({from: '/inbox'});
  const view: Queue = search.view ?? 'waiting';
  const filterable = PRIORITY_VIEWS.has(view);
  const priority: TicketPriority | undefined = filterable ? search.priority : undefined;
  const ticket: number | undefined = search.ticket;

  const wide = useMediaQuery('(min-width: 1281px)');
  const phone = useMediaQuery('(max-width: 640px)');

  const tickets = useInfiniteQuery(inboxTicketsQuery({view, priority}));
  // The server filters; the same filter here keeps an older page honest while it refetches.
  const rows: InboxRow[] | undefined = tickets.data?.pages.flatMap(page => page.items).filter(row => !priority || row.priority === priority);

  const panes = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((text: string) => {
    // A repeat of the same words is read again only if the text changes.
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const [mode, setMode] = useState<ComposerMode>('reply');
  const composerRef = useRef<ComposerHandle | null>(null);
  const drafts = useRef(new Map<number, string>()).current;
  const [focusTitle, setFocusTitle] = useState(false);
  const clearFocusTitle = useCallback(() => setFocusTitle(false), []);

  // Filters: a new history entry (Back undoes a filter). Picks: replace (no history spam),
  // except on a phone, where the list and the ticket are two screens and Back returns to the list.
  const setView = (next: Queue) =>
    void navigate({to: '/inbox', search: prev => ({...prev, view: next === 'waiting' ? undefined : next})});
  const setPriority = (next: string) =>
    void navigate({to: '/inbox', search: prev => ({...prev, priority: (next || undefined) as TicketPriority | undefined})});
  const pick = (row: InboxRow) => {
    setMode('reply');
    void navigate({to: '/inbox', search: prev => ({...prev, ticket: row.number}), replace: !phone});
    // Focus (the row on J / K, the title on a phone) says which ticket opened: no live announcement.
    if (phone) setFocusTitle(true);
  };
  const closeTicket = () => void navigate({to: '/inbox', search: prev => ({...prev, ticket: undefined}), replace: true});

  // Back on a phone: focus returns to the row of the ticket you came from.
  const returnTo = useRef<number | null>(null);
  const back = () => {
    returnTo.current = ticket ?? null;
    closeTicket();
  };
  useEffect(() => {
    if (ticket !== undefined || returnTo.current === null) return;
    const n = returnTo.current;
    returnTo.current = null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.screen-inbox-list [data-ticket="${n}"]`)?.focus());
  }, [ticket]);

  // Where J / K continue from when the open ticket has left the list (solved in "Waiting on us").
  const lastIndex = useRef(-1);
  const at = rows?.findIndex(row => row.number === ticket) ?? -1;
  if (at >= 0) lastIndex.current = at;

  // Keyboard: J / K move through the loaded list, R / N focus the composer.
  const latest = useRef({rows, ticket, pick});
  latest.current = {rows, ticket, pick};
  useEffect(() => {
    const root = panes.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsBlocked(event)) return;
      const key = event.key.toLowerCase();
      const {rows: list, ticket: open, pick: choose} = latest.current;
      if (key === 'j' || key === 'k') {
        if (!list?.length) return;
        const current = list.findIndex(row => row.number === open);
        const step = key === 'j' ? 1 : -1;
        // The open ticket left the list: its old place now holds the next one.
        const to = current >= 0 ? current + step : lastIndex.current >= 0 ? lastIndex.current + Math.min(step, 0) : 0;
        const row = list[to];
        if (!row) return; // at either end of the loaded list: nothing (no auto-load)
        event.preventDefault();
        choose(row);
        requestAnimationFrame(() => {
          const link = document.querySelector<HTMLElement>(`.screen-inbox-list [data-ticket="${row.number}"]`);
          link?.focus();
          link?.scrollIntoView({block: 'nearest'});
        });
      } else if ((key === 'r' || key === 'n') && open !== undefined) {
        event.preventDefault();
        setMode(key === 'r' ? 'reply' : 'note');
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---------------------------------------------------------------- list --
  let list: ReactNode;
  if (tickets.isPending) {
    list = (
      <div className="screen-inbox-list-state">
        <LoadingBlock rows={6} />
      </div>
    );
  } else if (tickets.error && !rows) {
    list = (
      <div className="screen-inbox-list-state">
        <ErrorNote title="Tickets could not load" error={tickets.error} />
        <Button variant="secondary" icon="refresh" pending={tickets.isRefetching} pendingLabel="Trying…" onClick={() => void tickets.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (!rows?.length) {
    const empty = EMPTY_VIEWS[view];
    list = (
      <div className="screen-inbox-list-state">
        {priority ? (
          <EmptyState
            icon="search"
            title={`No ${PRIORITY_LABELS[priority].toLowerCase()} tickets here`}
            action={
              <Button variant="secondary" onClick={() => setPriority('')}>
                Show every priority
              </Button>
            }>
            Try another priority.
          </EmptyState>
        ) : (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            action={
              view === 'mine' ? (
                <Button variant="secondary" onClick={() => setView('waiting')}>
                  Show waiting tickets
                </Button>
              ) : undefined
            }>
            {empty.body}
          </EmptyState>
        )}
      </div>
    );
  } else {
    list = (
      <>
        <ul role="list">
          {rows.map(row => (
            <li key={row.number}>
              <ConversationListItem
                customerName={row.customer.name}
                subject={row.subject}
                lastMessageAt={row.lastMessageAt}
                ageLabel={ago(row.lastMessageAt)}
                status={row.status}
                priority={row.priority}
                number={row.number}
                unread={false}
                selected={row.number === ticket}
                renderLink={props => (
                  <Link
                    {...props}
                    to="/inbox"
                    search={prev => ({...prev, ticket: row.number})}
                    replace={!phone}
                    data-ticket={row.number}
                    onClick={event => {
                      // Let the router navigate; we only reset the composer and, on a phone, move focus.
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      setMode('reply');
                      if (phone) setFocusTitle(true);
                    }}
                  />
                )}
              />
            </li>
          ))}
        </ul>
        <LoadMore query={tickets} />
        {tickets.error && (
          <div className="screen-inbox-list-state">
            <ErrorNote title="Tickets could not refresh" error={tickets.error} />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app-page screen-inbox" data-pane={ticket !== undefined ? 'thread' : 'list'}>
      <header className="screen-inbox-head">
        <PageHeader title="Inbox" description="Tickets from customers who asked for a person." />
        <div className="toolbar screen-inbox-toolbar">
          <SegmentedControl label="Show tickets" value={view} onChange={setView} options={VIEW_OPTIONS} />
          {filterable && (
            <Select aria-label="Priority" value={priority ?? ''} onChange={event => setPriority(event.target.value)} options={PRIORITY_OPTIONS} />
          )}
        </div>
      </header>

      <div className="screen-inbox-panes" ref={panes}>
        <section className="screen-inbox-list" aria-labelledby="inbox-list-title">
          <h3 id="inbox-list-title" className="visually-hidden">
            {VIEW_TITLES[view]}
          </h3>
          {list}
          {rows && rows.length > 1 && (
            <p className="screen-inbox-tip">
              Tip: press <kbd>J</kbd> and <kbd>K</kbd> to move between tickets.
            </p>
          )}
        </section>

        {ticket === undefined ? (
          <section className="screen-inbox-thread" aria-labelledby="inbox-thread-title">
            <div className="screen-inbox-thread-state">
              <h2 id="inbox-thread-title" className="visually-hidden">
                No ticket open
              </h2>
              {rows && rows.length === 0 ? (
                <EmptyState icon="inbox" title="No ticket open">
                  {priority ? 'Tickets with this priority open here.' : NO_TICKET_TEXT[view]}
                </EmptyState>
              ) : (
                <EmptyState icon="inbox" title="Pick a ticket">
                  Choose a ticket from the list to read and answer it.
                </EmptyState>
              )}
            </div>
          </section>
        ) : (
          <TicketView
            key={ticket}
            number={ticket}
            wide={wide}
            focusTitle={focusTitle}
            onTitleFocused={clearFocusTitle}
            onBack={back}
            onClose={closeTicket}
            mode={mode}
            onModeChange={setMode}
            composerRef={composerRef}
            drafts={drafts}
            announce={announce}
          />
        )}
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
