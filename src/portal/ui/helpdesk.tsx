import {type ReactNode, type Ref, type TextareaHTMLAttributes, useEffect, useId, useState} from 'react';

import {
  PRIORITY_LABELS,
  PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  type TicketPriority,
  type TicketStatus,
} from '../../lib/helpdesk-tones';
import {Badge, Person, StatusBadge} from './display';
import {Icon} from './icon';
import {Tabs, useRovingKeys} from './nav';

/**
 * Help desk pieces: the ticket's details panel, the article editor and the
 * 1–5 rating a customer gives a solved request.
 * Classes live in `src/styles/app.css` (`.ticket-meta`, `.article-editor`, `.rating-scale`);
 * colours come from `src/lib/helpdesk-tones.ts`, mapped once for every screen.
 */

// ------------------------------------------------------------ ticket meta --

/**
 * The ticket's details as label / value rows (the inbox's right pane, or a
 * `Drawer` on tablets). Each row shows its value read-only, or the control a
 * screen passes in `controls` (a `Select` to change the status, say), so the
 * layout stays the same whether the viewer can edit or not.
 */
export function TicketMeta({
  number,
  status,
  priority,
  assignee,
  customer,
  created,
  controls = {},
  extra = [],
  label = 'Ticket details',
}: {
  /** The ticket number, shown as `#1042` in the mono font. */
  number: number | string;
  status: TicketStatus;
  priority: TicketPriority;
  /** The agent's name, or null when nobody has it yet. */
  assignee: string | null;
  /** The customer's name (never their email here), and a detail line. */
  customer: {name: string; detail?: ReactNode};
  /** Already formatted by the screen ("12 Nov, 09:14" or "3 min ago"). */
  created: ReactNode;
  /** A control in place of the read-only value, for viewers who may change it. */
  controls?: Partial<Record<'status' | 'priority' | 'assignee', ReactNode>>;
  /** More rows after the standard ones (language, page, CSAT…). */
  extra?: {label: ReactNode; value: ReactNode}[];
  /** What the list is, for screen readers. */
  label?: string;
}) {
  const rows: {key: string; label: ReactNode; value: ReactNode}[] = [
    {key: 'number', label: 'Ticket', value: <span className="ticket-number">#{number}</span>},
    {
      key: 'status',
      label: 'Status',
      value: controls.status ?? <StatusBadge tone={TICKET_STATUS_TONES[status]}>{TICKET_STATUS_LABELS[status]}</StatusBadge>,
    },
    {
      key: 'priority',
      label: 'Priority',
      value: controls.priority ?? <Badge tone={PRIORITY_TONES[priority]}>{PRIORITY_LABELS[priority]}</Badge>,
    },
    {
      key: 'assignee',
      label: 'Assignee',
      value: controls.assignee ?? (assignee ? <Person name={assignee} /> : <span className="muted">Unassigned</span>),
    },
    {key: 'customer', label: 'Customer', value: <Person name={customer.name} detail={customer.detail} />},
    {key: 'created', label: 'Created', value: created},
    ...extra.map((row, i) => ({key: `extra-${i}`, label: row.label, value: row.value})),
  ];
  return (
    <section aria-label={label}>
      <dl className="ticket-meta">
        {rows.map(row => (
          <div className="ticket-meta-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// --------------------------------------------------------- article editor --

type EditorTab = 'write' | 'preview';

/**
 * A help article's body: Markdown in a labelled textarea, with Write /
 * Preview tabs and a character count. Wire it like any field:
 * `<ArticleEditor label="Body" {...form.field('body')} error={form.error('body')} renderPreview={…} />`.
 *
 * The preview is the screen's job (`renderPreview`): the site renders
 * Markdown on the server through `sanitizeHtml`. This component never injects
 * HTML itself.
 */
export function ArticleEditor({
  label,
  hint,
  error,
  id,
  value,
  maxLength = 50_000,
  renderPreview,
  ref,
  rows = 14,
  'aria-describedby': describedBy,
  ...textarea
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  id: string;
  value: string;
  onChange: (event: {target: {value: string}}) => void;
  maxLength?: number;
  /** Turns the Markdown into what the Preview tab shows. */
  renderPreview: (markdown: string) => ReactNode;
  ref?: Ref<HTMLTextAreaElement> | ((node: HTMLElement | null) => void);
}) {
  const [tab, setTab] = useState<EditorTab>('write');
  // A submit that finds an error focuses this field: be on the tab that has it.
  useEffect(() => {
    if (error) setTab('write');
  }, [error]);

  const countId = `${id}-count`;
  const near = value.length >= maxLength * 0.9;
  return (
    <div className="field article-editor" data-invalid={error ? '' : undefined}>
      <label htmlFor={id}>{label}</label>
      <Tabs
        label="Editor mode"
        value={tab}
        onChange={setTab}
        items={[
          {value: 'write', label: 'Write'},
          {value: 'preview', label: 'Preview'},
        ]}>
        {/* The textarea stays mounted on the Preview tab (hidden, still focusable),
            so a submit can focus it and the label always has its field. */}
        <textarea
          {...textarea}
          ref={ref as Ref<HTMLTextAreaElement>}
          id={id}
          value={value}
          rows={rows}
          maxLength={maxLength}
          spellCheck
          className={tab === 'write' ? 'article-editor-input' : 'article-editor-input visually-hidden'}
          aria-invalid={error ? true : textarea['aria-invalid']}
          aria-describedby={[describedBy ?? (error ? `${id}-error` : hint ? `${id}-hint` : undefined), countId]
            .filter(Boolean)
            .join(' ')}
          onFocus={event => {
            setTab('write');
            textarea.onFocus?.(event);
          }}
        />
        {tab === 'preview' && (
          <div className="article-editor-preview">
            {value.trim() ? (
              renderPreview(value)
            ) : (
              <p className="article-editor-empty">
                <Icon name="file" size={16} />
                Nothing to preview yet. Write the article on the Write tab.
              </p>
            )}
          </div>
        )}
      </Tabs>
      <div className="article-editor-foot">
        {hint && !error ? (
          <p className="field-hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : (
          <span />
        )}
        <p className="article-editor-count" id={countId} data-near={near ? '' : undefined} aria-live={near ? 'polite' : undefined}>
          {value.length.toLocaleString()} / {maxLength.toLocaleString()} characters
        </p>
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------- rating scale --

export type Rating = 1 | 2 | 3 | 4 | 5;

/** What each score means, read out with its number ("4 out of 5, Good"). */
export const RATING_WORDS: Record<Rating, string> = {1: 'Very poor', 2: 'Poor', 3: 'OK', 4: 'Good', 5: 'Great'};
const RATINGS: Rating[] = [1, 2, 3, 4, 5];

/**
 * A 1–5 score (how did we do?): a labelled radio group of five square
 * buttons, arrow keys move and pick, the low and high words under the ends.
 * Controlled: `value` is null until the person picks. `SegmentedControl` is
 * for two to four filters and `RadioCards` for explained choices; this is
 * for a score.
 *
 * `id` lands on the group, so a screen can focus it
 * (`document.getElementById(id)?.querySelector('button')?.focus()`).
 */
export function RatingScale({
  label,
  value,
  onChange,
  lowLabel = RATING_WORDS[1],
  highLabel = RATING_WORDS[5],
  disabled = false,
  error,
  id: givenId,
}: {
  /** What is rated ("Rate our help"), shown above the buttons. */
  label: string;
  value: number | null;
  onChange: (value: Rating) => void;
  /** Under the 1. */
  lowLabel?: string;
  /** Under the 5. */
  highLabel?: string;
  disabled?: boolean;
  /** Why the score is missing, in words ("Pick a number from 1 to 5."). */
  error?: string;
  id?: string;
}) {
  const ownId = useId();
  const id = givenId ?? ownId;
  const index = value !== null && value >= 1 && value <= 5 ? value - 1 : -1;
  const {refs, onKeyDown} = useRovingKeys(RATINGS.length, Math.max(index, 0), i => {
    if (!disabled) onChange(RATINGS[i]!);
  });
  return (
    <div className="rating-scale" data-invalid={error ? '' : undefined}>
      <p className="rating-scale-label" id={`${id}-label`}>
        {label}
      </p>
      <div
        className="rating-scale-options"
        role="radiogroup"
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        aria-disabled={disabled || undefined}
        onKeyDown={disabled ? undefined : onKeyDown}>
        {RATINGS.map((score, i) => (
          <button
            key={score}
            ref={node => {
              refs.current[i] = node;
            }}
            type="button"
            role="radio"
            className="rating-scale-option"
            aria-checked={score === value}
            aria-label={`${score} out of 5, ${RATING_WORDS[score]}`}
            // One tab stop: the picked score, or the first while nothing is picked.
            tabIndex={i === (index < 0 ? 0 : index) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(score)}>
            {score}
          </button>
        ))}
      </div>
      <div className="rating-scale-ends" aria-hidden="true">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
