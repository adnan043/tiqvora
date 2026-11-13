import type {ReactNode} from 'react';

import {CONFIDENCE_LABELS, CONFIDENCE_TONES, type Confidence} from '../../lib/helpdesk-tones';
import {Avatar, Badge} from './display';
import {Icon} from './icon';

/**
 * The help desk's conversation pieces: one message, a status line in the
 * thread, the sources an AI answer used, and how sure the AI was. Used by the
 * ticket view, "My support" and the Test Lab, so a conversation looks the
 * same everywhere. Bodies are plain text (React escapes them): never HTML.
 * No `style={}`: classes in `src/styles/app.css` (`.chat-*`).
 */

// --------------------------------------------------------------- message --

export type ChatSender = 'customer' | 'ai' | 'agent' | 'note';

const SENDER_LABELS: Record<ChatSender, string> = {
  customer: 'Customer',
  ai: 'Assistant',
  agent: 'Agent',
  note: 'Internal note',
};

/**
 * One message in a thread. `customer` sits in a soft bubble, `ai` is plain
 * text with no bubble, `agent` is a bubble on the other side, `note` (staff
 * only, never shown to the customer) sits on `--warning-soft`. `author` is
 * a name, never an email address. `time` is the text to show ("3 min ago"),
 * `dateTime` the ISO value for the `<time>` element. `footer` holds what
 * follows an answer: sources, feedback, "Talk to a person".
 */
export function ChatMessage({
  sender,
  author,
  time,
  dateTime,
  children,
  footer,
}: {
  sender: ChatSender;
  author?: string;
  time?: string;
  dateTime?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const name = author || SENDER_LABELS[sender];
  return (
    <article className={`chat-message chat-message-${sender}`} aria-label={!author ? SENDER_LABELS[sender] : author.startsWith(SENDER_LABELS[sender]) ? author : `${SENDER_LABELS[sender]}: ${author}`}>
      <div className="chat-message-head">
        {sender === 'ai' ? (
          <span className="chat-message-mark" aria-hidden="true">
            <Icon name="zap" size={14} />
          </span>
        ) : sender === 'note' ? (
          <span className="chat-message-mark" aria-hidden="true">
            <Icon name="lock" size={14} />
          </span>
        ) : (
          <Avatar name={name} size="sm" />
        )}
        <span className="chat-message-author">{name}</span>
        {sender === 'note' && <span className="chat-message-kind">Only your team sees this</span>}
        {time && (
          <time className="chat-message-time" dateTime={dateTime}>
            {time}
          </time>
        )}
      </div>
      <div className="chat-message-body">{children}</div>
      {footer && <div className="chat-message-footer">{footer}</div>}
    </article>
  );
}

/**
 * A small grey line in the thread for something that happened rather than
 * something said: "Assigned to Sam", "Status changed to Pending".
 */
export function TimelineEvent({children, time, dateTime}: {children: ReactNode; time?: string; dateTime?: string}) {
  return (
    <p className="chat-event">
      <span className="chat-event-text">{children}</span>
      {time && (
        <time className="chat-event-time" dateTime={dateTime}>
          {time}
        </time>
      )}
    </p>
  );
}

// --------------------------------------------------------------- sources --

export interface Citation {
  title: string;
  href: string;
}

/**
 * The articles an AI answer used, numbered as the answer cites them ([1],
 * [2]…). Links are this site's own help-center pages. `newTab` opens them in a
 * new tab (an external-link icon, and "(opens in a new tab)" for screen
 * readers): use it where leaving the page would lose work, like a draft reply.
 */
export function CitationList({items, title = 'Sources', newTab = false}: {items: Citation[]; title?: string; newTab?: boolean}) {
  if (!items.length) return null;
  return (
    <div className="citation-list">
      <p className="citation-list-title">{title}</p>
      <ol className="citation-list-items">
        {items.map((item, index) => (
          <li key={`${index}-${item.href}`}>
            <a className="citation-link" href={item.href} {...(newTab ? {target: '_blank', rel: 'noopener noreferrer'} : {})}>
              <span className="citation-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="citation-title">{item.title}</span>
              {newTab && (
                <>
                  <Icon name="external" size={14} />
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </>
              )}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------ confidence --

/** How sure the AI was of an answer, in words and colour (`helpdesk-tones.ts`). */
export function ConfidenceBadge({confidence}: {confidence: Confidence}) {
  return <Badge tone={CONFIDENCE_TONES[confidence]}>{CONFIDENCE_LABELS[confidence]}</Badge>;
}
