import {useInfiniteQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type KeyboardEvent, useDeferredValue, useEffect, useId, useMemo, useState} from 'react';

import type {CannedReply} from '../../../lib/helpdesk-tickets';
import {matchSavedReplies, savedRepliesQuery} from '../../queries';
import {Button, buttonClass, EmptyState, ErrorNote, LoadingBlock, Modal, SearchInput} from '../../ui';

/** The search box's limit (the saved replies list holds at most 100). */
const SEARCH_MAX = 80;

/**
 * The placeholders a saved reply may hold, filled in on insert (never on the server).
 * The Saved replies screen warns about any other `{{…}}`: it would reach the customer as typed.
 */
export const SAVED_REPLY_PLACEHOLDERS = ['customer.firstName', 'agent.firstName'] as const;

/** Every `{{ name }}` in a text (spaces inside the braces allowed). */
export const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Fill the placeholders. A function replacer: a name such as `$'` is inserted as typed. */
export function fillPlaceholders(body: string, names: {customer: string; agent: string}): string {
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? '';
  const values: Record<string, string> = {'customer.firstName': first(names.customer), 'agent.firstName': first(names.agent)};
  return body.replace(PLACEHOLDER_RE, (match, name: string) => (Object.hasOwn(values, name) ? values[name]! : match));
}

/**
 * "Insert a saved reply" (screens doc 4.6): type to narrow the list (in the browser, from the
 * ONE cached list), ArrowDown / ArrowUp to move, Enter or a click to pick; it goes into the
 * composer at the caret. Saved replies are the team's own list (`/site-api/helpdesk/canned`),
 * managed on the Saved replies screen.
 */
export function SavedRepliesModal({open, onClose, onPick}: {open: boolean; onClose: () => void; onPick: (reply: CannedReply) => void}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(0);
  const replies = useInfiniteQuery({...savedRepliesQuery(''), enabled: open});
  // Typing stays instant; the list narrows a beat later on a slow device.
  const q = useDeferredValue(draft.trim());
  const all = useMemo(() => replies.data?.pages.flatMap(page => page.replies), [replies.data]);
  const rows = useMemo(() => (all ? matchSavedReplies(all, q) : undefined), [all, q]);
  const current = rows?.length ? Math.min(active, rows.length - 1) : -1;
  const searchId = `${id}-search`;
  const focusSearch = () => document.getElementById(searchId)?.focus();

  // Each opening starts afresh, with the caret in the search box (after the dialog's own focus).
  useEffect(() => {
    if (!open) return;
    setDraft('');
    setActive(0);
    focusSearch();
  }, [open]);

  // Keep the highlighted reply in view while moving with the keys.
  useEffect(() => {
    if (current >= 0) document.getElementById(`${id}-opt-${current}`)?.scrollIntoView({block: 'nearest'});
  }, [current, id]);

  // The search box is a combobox: the arrows move through the results, Enter picks one.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!rows?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(event.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && current >= 0 && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onPick(rows[current]!);
    }
  };

  const listId = `${id}-list`;
  let body;
  if (replies.isPending) body = <LoadingBlock rows={3} />;
  else if (replies.error)
    body = (
      <div className="saved-replies-error">
        <ErrorNote title="Saved replies could not load" error={replies.error} />
        <Button variant="secondary" icon="refresh" pending={replies.isFetching} pendingLabel="Trying again…" onClick={() => void replies.refetch()}>
          Try again
        </Button>
      </div>
    );
  else if (!rows?.length)
    body = q ? (
      <EmptyState
        icon="search"
        title="No saved replies match"
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setDraft('');
              focusSearch();
            }}>
            Clear the search
          </Button>
        }>
        Nothing matches “{q}”. Try fewer or different words.
      </EmptyState>
    ) : (
      <EmptyState
        icon="copy"
        title="No saved replies yet"
        action={
          <Link className={buttonClass({variant: 'secondary'})} to="/saved-replies" onClick={onClose}>
            Add a saved reply
          </Link>
        }>
        Saved replies are short answers your team reuses.
      </EmptyState>
    );
  else
    body = (
      <ul className="saved-replies-list" id={listId} role="listbox" aria-label="Saved replies">
        {rows.map((reply, i) => (
          // Picked by a click, or from the search box (arrows + Enter): focus stays in the box.
          <li
            key={reply.id}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === current}
            className="saved-replies-option"
            onMouseMove={() => i !== current && setActive(i)}
            onClick={() => onPick(reply)}>
            <span className="saved-replies-title">{reply.title}</span>
            <span className="saved-replies-text">{reply.body.split('\n')[0]}</span>
          </li>
        ))}
      </ul>
    );

  const hasList = Boolean(rows?.length) && !replies.error;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Insert a saved reply"
      description="Picks go into your reply, where you can edit them."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }>
      <div className="screen-inbox-replies saved-replies-picker">
        <div role="search">
          <SearchInput
            id={searchId}
            label="Search saved replies"
            placeholder="e.g. refund"
            value={draft}
            maxLength={SEARCH_MAX}
            autoComplete="off"
            role="combobox"
            aria-expanded={hasList}
            aria-controls={hasList ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={hasList && current >= 0 ? `${id}-opt-${current}` : undefined}
            onChange={event => {
              setDraft(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {body}
        <p className="visually-hidden" aria-live="polite">
          {rows && !replies.error ? `${rows.length} saved repl${rows.length === 1 ? 'y' : 'ies'}` : ''}
        </p>
      </div>
    </Modal>
  );
}
