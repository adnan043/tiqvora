import {type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState} from 'react';

import {
  PRIORITY_LABELS,
  PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  type TicketPriority,
  type TicketStatus,
} from '../../lib/helpdesk-tones';
import {Button} from './button';
import {Avatar, Badge, StatusBadge} from './display';
import {SegmentedControl} from './nav';

/**
 * The help desk's message pieces (docs/design-system.md):
 * - `Composer`: where a customer or an agent writes a message.
 * - `ConversationListItem`: one ticket in the inbox list.
 */

// --------------------------------------------------------------- composer --

export type ComposerMode = 'reply' | 'note';

/** The counter shows once the text is this close to `maxLength`. */
const COUNTER_FROM = 0.8;
/** The composer grows to this many lines, then scrolls. */
const MAX_LINES = 6;

/**
 * A labelled textarea and its Send button. One line tall when empty, it grows
 * with the text up to six lines, then scrolls. Enter sends, Shift+Enter adds
 * a line.
 *
 * `onSend` returns a Promise: the text is cleared only when it resolves, so a
 * failed send never loses what was typed (show the error with `error`).
 * With `modes`, a Reply / Note switch sits above it; a note is drawn on the
 * warning fill so nobody mistakes it for a reply the customer will see.
 */
export function Composer({
  label,
  onSend,
  pending = false,
  disabled = false,
  maxLength = 4000,
  placeholder,
  modes,
  mode: controlledMode,
  onModeChange,
  sendLabel = 'Send',
  pendingLabel = 'Sending…',
  error,
  hint,
}: {
  /** What the box is for ("Reply to Maya"). Always shown above it; "Internal note" in note mode. */
  label: string;
  onSend: (text: string, mode: ComposerMode) => Promise<unknown>;
  pending?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** An example, never the label. */
  placeholder?: string;
  /** Show the Reply / Note switch (agents only). */
  modes?: boolean;
  mode?: ComposerMode;
  onModeChange?: (mode: ComposerMode) => void;
  sendLabel?: string;
  pendingLabel?: string;
  /** Why the last send failed, in words. Stays until the next send. */
  error?: string;
  /** A short line under the box ("Answers in about 2 hours"). */
  hint?: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [ownMode, setOwnMode] = useState<ComposerMode>('reply');
  const mode = controlledMode ?? ownMode;
  const setMode = (next: ComposerMode) => {
    if (controlledMode === undefined) setOwnMode(next);
    onModeChange?.(next);
  };

  // Grow with the text: one control high when empty, at most MAX_LINES lines.
  // element.style is allowed by the CSP (a style="" attribute is not). Layout
  // effect: sized before paint, so the box never flickers.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const css = getComputedStyle(el);
    const line = parseFloat(css.lineHeight) || 24;
    const chrome = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    const max = line * MAX_LINES + chrome;
    const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    const wanted = el.scrollHeight + border;
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [text]);

  const trimmed = text.trim();
  const busy = pending || disabled;
  const canSend = !busy && trimmed.length > 0 && text.length <= maxLength;

  const send = async () => {
    if (!canSend) return;
    try {
      await onSend(trimmed, mode);
      setText('');
    } catch {
      // Keep the text: the caller shows the error through `error`.
    } finally {
      // The disabled Send button dropped focus: give it back to the box.
      ref.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const showCounter = text.length >= maxLength * COUNTER_FROM;
  const describedBy = [error ? `${id}-error` : '', hint && !error ? `${id}-hint` : '', showCounter ? `${id}-count` : ''].filter(Boolean).join(' ') || undefined;

  return (
    <form
      className={['composer', mode === 'note' ? 'composer-note' : ''].filter(Boolean).join(' ')}
      noValidate
      aria-busy={pending || undefined}
      onSubmit={event => {
        event.preventDefault();
        void send();
      }}>
      {modes && (
        <div className="composer-modes">
          <SegmentedControl
            label="Message type"
            value={mode}
            onChange={setMode}
            options={[
              {value: 'reply', label: 'Reply'},
              {value: 'note', label: 'Internal note'},
            ]}
          />
          {mode === 'note' && <span className="composer-mode-hint">Only your team sees notes.</span>}
        </div>
      )}
      <label className="composer-label" htmlFor={id}>
        {mode === 'note' ? 'Internal note' : label}
      </label>
      <div className="composer-box">
        <textarea
          ref={ref}
          id={id}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={pending}
          aria-invalid={error || text.length > maxLength ? true : undefined}
          aria-describedby={describedBy}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" icon="arrow-right" pending={pending} pendingLabel={pendingLabel} disabled={!canSend && !pending}>
          {mode === 'note' ? 'Add note' : sendLabel}
        </Button>
      </div>
      <div className="composer-foot">
        {error ? (
          <p className="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : (
          hint && (
            <p className="field-hint" id={`${id}-hint`}>
              {hint}
            </p>
          )
        )}
        {showCounter && (
          <p className={['composer-count', text.length > maxLength ? 'composer-count-over' : ''].filter(Boolean).join(' ')} id={`${id}-count`} aria-live="polite">
            {text.length > maxLength ? `${text.length - maxLength} characters too long` : `${maxLength - text.length} characters left`}
          </p>
        )}
      </div>
    </form>
  );
}

// --------------------------------------------------- conversation list item --

/** The props a link must spread to look and behave like the row (`renderLink`). */
export interface ConversationLinkProps {
  className: string;
  'aria-current': 'true' | undefined;
  children: ReactNode;
}

/**
 * One ticket in the inbox list: the customer, the subject, the last message
 * on one line, how long ago, its status and priority, and a dot when it has
 * something unread.
 *
 * A button by default (`onSelect`). In a routed list pass `renderLink` and
 * return the router's `<Link>` with the given props, so it navigates
 * client-side: `renderLink={p => <Link to="/dashboard/inbox/$id" params={{id}} {...p} />}`.
 */
export function ConversationListItem({
  customerName,
  customerAvatar,
  subject,
  preview,
  lastMessageAt,
  ageLabel,
  status,
  priority,
  number,
  unread = false,
  selected = false,
  onSelect,
  renderLink,
}: {
  customerName: string;
  customerAvatar?: string | null;
  subject: string;
  /** The last message, plain text. Cut to one line by CSS. */
  preview?: string;
  /** ISO time of the last message, for the `<time>` element. */
  lastMessageAt: string;
  /** "3 min ago" (`ago()` from `../shared`). */
  ageLabel: string;
  status: TicketStatus;
  priority?: TicketPriority;
  /** The ticket number ("1042"), shown in mono. */
  number?: number | string;
  unread?: boolean;
  selected?: boolean;
} & (
  | {onSelect: () => void; renderLink?: never}
  | {renderLink: (props: ConversationLinkProps) => ReactNode; onSelect?: never}
)) {
  const className = ['conversation-item', selected ? 'is-selected' : '', unread ? 'is-unread' : ''].filter(Boolean).join(' ');
  const showPriority = priority === 'urgent' || priority === 'high';
  const children = (
    <>
      <Avatar name={customerName} src={customerAvatar} size="sm" />
      <span className="conversation-item-body">
        <span className="conversation-item-top">
          <span className="conversation-item-name">
            {unread && (
              <span className="conversation-item-dot">
                <span className="visually-hidden">Unread: </span>
              </span>
            )}
            {customerName}
          </span>
          <time className="conversation-item-age" dateTime={lastMessageAt}>
            {ageLabel}
          </time>
        </span>
        <span className="conversation-item-subject">
          {number !== undefined && <span className="conversation-item-number">#{number}</span>}
          {subject}
        </span>
        {preview && <span className="conversation-item-preview">{preview}</span>}
        <span className="conversation-item-meta">
          <StatusBadge tone={TICKET_STATUS_TONES[status]}>{TICKET_STATUS_LABELS[status]}</StatusBadge>
          {showPriority && priority && <Badge tone={PRIORITY_TONES[priority]}>{PRIORITY_LABELS[priority]}</Badge>}
        </span>
      </span>
    </>
  );
  if (renderLink) return <>{renderLink({className, 'aria-current': selected ? 'true' : undefined, children})}</>;
  return (
    <button type="button" className={className} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      {children}
    </button>
  );
}
