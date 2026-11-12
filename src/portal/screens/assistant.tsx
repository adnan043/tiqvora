import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState} from 'react';

import {AI_MODELS, aiModelOf} from '../../lib/ai-models';
import {ASK_LIMITS, type HelpdeskSettingsAdmin, type HelpdeskSettingsInput} from '../../lib/helpdesk-types';
import {api, ApiError, read} from '../api';
import {helpdeskSettingsQuery} from '../queries';
import {
  Button,
  Card,
  ErrorNote,
  Field,
  IconButton,
  LoadingBlock,
  Notice,
  PageHeader,
  ProgressBar,
  RadioCards,
  rules,
  Select,
  SettingRow,
  useForm,
  useToast,
} from '../ui';

/**
 * Holders of `site:helpdesk:settings`: what the assistant is called and how it talks, which
 * model answers, how much it may spend a month, the chat button, the topics that always go to
 * a person and the help center's words (`/site-api/helpdesk/settings`). One card per topic,
 * each saved on its own (only its fields are sent). The AI key is an owner secret added in the
 * site's settings: this screen only says whether it is there, never shows or takes it.
 */

type Tone = HelpdeskSettingsAdmin['tone'];
type Threshold = HelpdeskSettingsAdmin['confidenceThreshold'];

const TONE_OPTIONS: {value: Tone; title: string; description: string}[] = [
  {value: 'friendly', title: 'Friendly', description: 'Warm and casual, like a helpful shop assistant.'},
  {value: 'neutral', title: 'Neutral', description: 'Plain and to the point.'},
  {value: 'formal', title: 'Formal', description: 'Polite and businesslike.'},
];

const THRESHOLD_OPTIONS: {value: Threshold; title: string; description: string}[] = [
  {value: 'low', title: 'Low', description: 'Answers unless it is unsure. Fewest hand-offs, but a wrong answer is more likely.'},
  {value: 'medium', title: 'Medium', description: 'Answers when it is fairly sure; otherwise it offers a person. Recommended.'},
  {value: 'high', title: 'High', description: 'Answers only when your help center clearly covers the question. Most hand-offs.'},
];

const MODEL_OPTIONS = AI_MODELS.map(model => ({value: model.id, label: model.label}));

const money = (cents: number) => (cents / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD'});
/** `2026-11` → "November 2026". */
const monthName = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? month : date.toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
};

/** Dollars typed by the owner ("20", "12.50") → cents; the rules below already checked the shape. */
const centsOf = (dollars: string) => Math.round(Number(dollars.trim()) * 100);
/** Cents → the field's text: "20" for whole dollars, "12.50" otherwise (never "12.5"). */
const dollarsOf = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const CAP_MAX_DOLLARS = ASK_LIMITS.monthlyCapCentsMax / 100;

const CAP_RULES = [
  rules.required('Enter an amount in dollars, like 20. Enter 0 to turn the assistant off.'),
  rules.pattern(/^\d{1,7}(\.\d{1,2})?$/, 'Use a dollar amount with up to 2 decimals, like 20 or 12.50.'),
  (value: string) =>
    Number(value.trim()) > CAP_MAX_DOLLARS ? `Enter at most ${money(ASK_LIMITS.monthlyCapCentsMax)}.` : null,
];

/** Field errors from the server that belong to `names`; anything else is shown in the card. */
const pick = (error: unknown, names: readonly string[]) => {
  if (!(error instanceof ApiError)) return null;
  const fields = Object.fromEntries(Object.entries(error.fields).filter(([name]) => names.includes(name)));
  return Object.keys(fields).length ? fields : null;
};

/** One card's save: PATCH only its fields, put the answer in the cache, say so. */
function useSave(names: readonly string[], onSaved: (next: HelpdeskSettingsAdmin) => void, onFields: (fields: Record<string, string>) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (json: HelpdeskSettingsInput) => read<HelpdeskSettingsAdmin>(api.helpdesk.settings.$patch({json})),
    onSuccess: next => {
      queryClient.setQueryData(helpdeskSettingsQuery.queryKey, next);
      onSaved(next);
      toast.success('Settings saved.');
    },
    onError: error => {
      const fields = pick(error, names);
      if (fields) onFields(fields);
    },
  });
}

/** A card that is a form: its rows, an error in words, Undo + Save in the footer. */
function SettingsCard({
  title,
  description,
  dirty,
  pending,
  error,
  names,
  onSubmit,
  onUndo,
  children,
}: {
  title: string;
  description: string;
  dirty: boolean;
  pending: boolean;
  error: Error | null;
  names: readonly string[];
  onSubmit: (event: FormEvent) => void;
  onUndo: () => void;
  children: ReactNode;
}) {
  // Errors the fields show themselves stay there; the rest (a 409, a lost connection) shows here.
  const cardError = error && !pick(error, names) ? error : null;
  return (
    <form noValidate onSubmit={onSubmit}>
      <Card
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={onUndo} disabled={!dirty || pending}>
              Undo changes
            </Button>
            <Button type="submit" pending={pending} pendingLabel="Saving…" disabled={!dirty}>
              Save
            </Button>
          </>
        }>
        <div className="form-stack">
          <div>{children}</div>
          {cardError && <ErrorNote error={cardError} />}
        </div>
      </Card>
    </form>
  );
}

/**
 * A short list edited in place (quick replies, human-only topics): an input with Add, and each
 * entry with its Remove button. Enter in the input adds; it never submits the card. The parent
 * remounts it (`key`) on Undo, which clears the input and its error. Focus never drops to the
 * page: after Remove it goes to the next entry's Remove (else the previous, else the input);
 * after Add it stays in the input (or the last Remove when the list is now full).
 */
function ListEditor({
  id,
  label,
  listLabel,
  hint,
  placeholder,
  items,
  onChange,
  max,
  maxLength,
  lower,
  chips,
  error,
  disabled,
}: {
  id: string;
  label: string;
  listLabel: string;
  hint: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
  max: number;
  maxLength: number;
  lower?: boolean;
  chips?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const full = items.length >= max;
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<{after: 'add'} | {after: 'remove'; index: number} | null>(null);

  // Runs once the parent has rendered the new list.
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const target =
      want.after === 'remove' ? (buttons[want.index] ?? buttons[want.index - 1]) : items.length >= max ? buttons[buttons.length - 1] : undefined;
    (target ?? inputRef.current)?.focus();
  }, [items, max]);

  const remove = (index: number) => {
    pendingFocus.current = {after: 'remove', index};
    onChange(items.filter((_, at) => at !== index));
  };

  const add = () => {
    let entry = draft.replace(/\s+/g, ' ').trim();
    if (lower) entry = entry.toLowerCase();
    if (!entry) return setProblem('Type something to add first.');
    if (entry.length > maxLength) return setProblem(`Use at most ${maxLength} characters.`);
    if (items.some(item => item.toLowerCase() === entry.toLowerCase())) return setProblem(`“${entry}” is already in the list.`);
    if (full) return setProblem(`You can have at most ${max}. Remove one first.`);
    pendingFocus.current = {after: 'add'};
    onChange([...items, entry]);
    setDraft('');
    setProblem(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  };
  const shown = problem ?? error;

  return (
    <div className="assistant-list-editor">
      {items.length > 0 &&
        (chips ? (
          <ul ref={listRef} className="chips assistant-chips" aria-label={listLabel}>
            {items.map((item, index) => (
              <li key={item} className="chip assistant-chip">
                <span>{item}</span>
                <IconButton icon="x" label={`Remove “${item}”`} disabled={disabled} onClick={() => remove(index)} />
              </li>
            ))}
          </ul>
        ) : (
          <ul ref={listRef} className="list assistant-rows" aria-label={listLabel}>
            {items.map((item, index) => (
              <li key={item} className="list-row">
                <span className="list-row-text">{item}</span>
                <IconButton icon="trash" label={`Remove “${item}”`} disabled={disabled} onClick={() => remove(index)} />
              </li>
            ))}
          </ul>
        ))}
      <Field id={id} label={label} hint={full ? `That’s the most you can have (${max}).` : hint} error={shown ?? undefined}>
        <div className="assistant-add">
          <input
            ref={inputRef}
            id={id}
            value={draft}
            maxLength={maxLength}
            autoComplete="off"
            placeholder={placeholder}
            disabled={disabled || full}
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? `${id}-error` : `${id}-hint`}
            onChange={event => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onKeyDown={onKeyDown}
          />
          <Button variant="secondary" icon="plus" onClick={add} disabled={disabled || full}>
            Add
          </Button>
        </div>
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------- cards --

const ASSISTANT_FIELDS = ['assistantName', 'greeting', 'tone'] as const;

function AssistantCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const initial = (s: HelpdeskSettingsAdmin) => ({assistantName: s.assistantName, greeting: s.greeting, tone: s.tone as string});
  const [saved, setSaved] = useState(() => initial(settings));
  const form = useForm(saved, {
    assistantName: [rules.required('Give the assistant a name, like "Mia" or "Support".'), rules.maxLength(ASK_LIMITS.assistantName)],
    greeting: [rules.required('Write the first thing the assistant says, like "Hi! How can I help?".'), rules.maxLength(ASK_LIMITS.greeting)],
  });
  const save = useSave(
    ASSISTANT_FIELDS,
    next => {
      setSaved(initial(next));
      form.reset(initial(next));
    },
    fields => form.setServerErrors(fields)
  );
  const v = form.values;
  const dirty = v.assistantName !== saved.assistantName || v.greeting !== saved.greeting || v.tone !== saved.tone;

  return (
    <SettingsCard
      title="Assistant"
      description="How the assistant introduces itself in the chat."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={ASSISTANT_FIELDS}
      onUndo={() => form.reset(saved)}
      onSubmit={form.submit(values =>
        save.mutate({assistantName: values.assistantName.trim(), greeting: values.greeting.trim(), tone: values.tone as Tone})
      )}>
      <SettingRow title="Name" description="Shown at the top of the chat panel.">
        <Field id="f-assistantName" label="Assistant’s name" error={form.error('assistantName')}>
          <input {...form.field('assistantName')} maxLength={ASK_LIMITS.assistantName} autoComplete="off" placeholder="Mia" />
        </Field>
      </SettingRow>
      <SettingRow title="Greeting" description="The first message a customer sees when they open the chat.">
        <Field id="f-greeting" label="Greeting" hint="One paragraph: line breaks become spaces." error={form.error('greeting')}>
          <textarea {...form.field('greeting')} maxLength={ASK_LIMITS.greeting} rows={3} placeholder="Hi! Ask me anything about our products and orders." />
        </Field>
      </SettingRow>
      <SettingRow title="Tone" description="How the assistant words its answers. The facts always come from your help center.">
        <RadioCards
          legend="Tone of voice"
          name="tone"
          value={v.tone as Tone}
          onChange={tone => form.set('tone', tone)}
          options={TONE_OPTIONS}
          columns={1}
        />
      </SettingRow>
    </SettingsCard>
  );
}

const ANSWER_FIELDS = ['model', 'confidenceThreshold'] as const;

function AnswersCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const initial = (s: HelpdeskSettingsAdmin) => ({model: aiModelOf(s.model).id, confidenceThreshold: s.confidenceThreshold as string});
  const [saved, setSaved] = useState(() => initial(settings));
  const form = useForm(saved, {model: [rules.required('Pick a model.')]});
  const save = useSave(
    ANSWER_FIELDS,
    next => {
      setSaved(initial(next));
      form.reset(initial(next));
    },
    fields => form.setServerErrors(fields)
  );
  const v = form.values;
  const dirty = v.model !== saved.model || v.confidenceThreshold !== saved.confidenceThreshold;

  return (
    <SettingsCard
      title="Answers"
      description="Which AI model writes the answers, and how sure it must be before it answers on its own."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={ANSWER_FIELDS}
      onUndo={() => form.reset(saved)}
      onSubmit={form.submit(values => save.mutate({provider: 'anthropic', model: values.model, confidenceThreshold: values.confidenceThreshold as Threshold}))}>
      <SettingRow title="Model" description="Anthropic’s Claude. A faster model costs less per answer.">
        <Field id="f-model" label="AI model" hint={aiModelOf(v.model).hint} error={form.error('model')}>
          <Select {...form.field('model')} options={MODEL_OPTIONS} />
        </Field>
      </SettingRow>
      <SettingRow
        title="Confidence needed"
        description="Below this, the assistant doesn’t answer on its own: it shows what it found and offers a person.">
        <RadioCards
          legend="Confidence needed to answer"
          name="confidenceThreshold"
          value={v.confidenceThreshold as Threshold}
          onChange={value => form.set('confidenceThreshold', value)}
          options={THRESHOLD_OPTIONS}
          columns={1}
        />
        {form.error('confidenceThreshold') && (
          <p className="field-error" role="alert">
            {form.error('confidenceThreshold')}
          </p>
        )}
      </SettingRow>
    </SettingsCard>
  );
}

const SPENDING_FIELDS = ['monthlyCapCents'] as const;

function SpendingCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const initial = (s: HelpdeskSettingsAdmin) => ({cap: dollarsOf(s.monthlyCapCents)});
  const [saved, setSaved] = useState(() => initial(settings));
  const form = useForm(saved, {cap: CAP_RULES});
  const save = useSave(
    SPENDING_FIELDS,
    next => {
      setSaved(initial(next));
      form.reset(initial(next));
    },
    fields => fields.monthlyCapCents && form.setServerErrors({cap: fields.monthlyCapCents})
  );
  const {usage, monthlyCapCents} = settings;
  const dirty = form.values.cap.trim() !== saved.cap;
  const reached = monthlyCapCents > 0 && usage.spentCents >= monthlyCapCents;

  return (
    <SettingsCard
      title="Spending"
      description="The most the assistant may spend on AI each calendar month. When it is reached, the chat still shows help-center links and offers a person."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={SPENDING_FIELDS}
      onUndo={() => form.reset(saved)}
      onSubmit={form.submit(values => save.mutate({monthlyCapCents: centsOf(values.cap)}))}>
      <SettingRow title="Monthly cap" description="In US dollars. 0 turns the assistant off.">
        <Field id="f-cap" label="Monthly cap ($)" hint="Like 20 or 12.50." error={form.error('cap')}>
          <input {...form.field('cap')} inputMode="decimal" autoComplete="off" placeholder="20" />
        </Field>
      </SettingRow>
      <SettingRow title={`This month (${monthName(usage.month)})`} description={`${usage.requests.toLocaleString('en-US')} AI answers so far.`}>
        <p className="assistant-spend">
          {money(usage.spentCents)} of {money(monthlyCapCents)}
        </p>
        <ProgressBar value={usage.spentCents} max={Math.max(monthlyCapCents, 1)} label={`Spent ${money(usage.spentCents)} of ${money(monthlyCapCents)} this month`} />
        {monthlyCapCents === 0 ? (
          <p className="field-hint">The cap is $0, so the assistant is off. Customers get help-center links and can ask for a person.</p>
        ) : reached ? (
          <p className="field-hint">The cap is reached: the assistant is resting until next month, or until you raise the cap.</p>
        ) : null}
      </SettingRow>
    </SettingsCard>
  );
}

const CHAT_FIELDS = ['launcherLabel', 'businessHours', 'quickReplies'] as const;

function ChatButtonCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const initial = (s: HelpdeskSettingsAdmin) => ({launcherLabel: s.launcherLabel, businessHours: s.businessHours});
  const [saved, setSaved] = useState(() => ({...initial(settings), quickReplies: settings.quickReplies}));
  const [replies, setReplies] = useState(settings.quickReplies);
  const [repliesError, setRepliesError] = useState<string | undefined>();
  const [repliesKey, setRepliesKey] = useState(0);
  const form = useForm(initial(settings), {
    launcherLabel: [rules.required('Write the button’s label, like "Support" or "Help".'), rules.maxLength(ASK_LIMITS.launcherLabel)],
    businessHours: [rules.maxLength(ASK_LIMITS.businessHours)],
  });
  const save = useSave(
    CHAT_FIELDS,
    next => {
      setSaved({...initial(next), quickReplies: next.quickReplies});
      setReplies(next.quickReplies);
      form.reset(initial(next));
    },
    ({quickReplies, ...rest}) => {
      setRepliesError(quickReplies);
      if (Object.keys(rest).length) form.setServerErrors(rest);
    }
  );
  const v = form.values;
  const dirty =
    v.launcherLabel !== saved.launcherLabel ||
    v.businessHours !== saved.businessHours ||
    replies.join('\n') !== saved.quickReplies.join('\n');

  return (
    <SettingsCard
      title="Chat button"
      description="The button in the corner of your website that opens the chat."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={CHAT_FIELDS}
      onUndo={() => {
        form.reset({launcherLabel: saved.launcherLabel, businessHours: saved.businessHours});
        setReplies(saved.quickReplies);
        setRepliesError(undefined);
        setRepliesKey(key => key + 1);
      }}
      onSubmit={form.submit(values =>
        save.mutate({launcherLabel: values.launcherLabel.trim(), businessHours: values.businessHours.trim(), quickReplies: replies})
      )}>
      <SettingRow title="Label" description="The word on the button.">
        <Field id="f-launcherLabel" label="Button label" error={form.error('launcherLabel')}>
          <input {...form.field('launcherLabel')} maxLength={ASK_LIMITS.launcherLabel} autoComplete="off" placeholder="Support" />
        </Field>
      </SettingRow>
      <SettingRow title="Business hours" description="When people answer, shown in the chat. Leave it empty to show nothing.">
        <Field id="f-businessHours" label="Business hours" optional error={form.error('businessHours')}>
          <input {...form.field('businessHours')} maxLength={ASK_LIMITS.businessHours} autoComplete="off" placeholder="Mon–Fri, 9am–5pm CET" />
        </Field>
      </SettingRow>
      <SettingRow
        title="Quick replies"
        description={`Questions customers can tap instead of typing, in this order. Up to ${ASK_LIMITS.quickReplies}.`}>
        <ListEditor
          key={repliesKey}
          id="f-new-reply"
          label="Add a quick reply"
          listLabel="Quick replies"
          hint="Press Enter or Add. Remember to save."
          placeholder="Where is my order?"
          items={replies}
          onChange={next => {
            setReplies(next);
            setRepliesError(undefined);
          }}
          max={ASK_LIMITS.quickReplies}
          maxLength={ASK_LIMITS.quickReplyLabel}
          error={repliesError}
          disabled={save.isPending}
        />
      </SettingRow>
    </SettingsCard>
  );
}

const HANDOFF_FIELDS = ['humanTopics'] as const;

function HandoffCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const [saved, setSaved] = useState(settings.humanTopics);
  const [topics, setTopics] = useState(settings.humanTopics);
  const [topicsError, setTopicsError] = useState<string | undefined>();
  const [topicsKey, setTopicsKey] = useState(0);
  const save = useSave(
    HANDOFF_FIELDS,
    next => {
      setSaved(next.humanTopics);
      setTopics(next.humanTopics);
    },
    fields => setTopicsError(fields.humanTopics)
  );
  const dirty = topics.join('\n') !== saved.join('\n');

  return (
    <SettingsCard
      title="Hand-off"
      description="Topics the assistant never answers: a question that mentions one goes straight to a person."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={HANDOFF_FIELDS}
      onUndo={() => {
        setTopics(saved);
        setTopicsError(undefined);
        setTopicsKey(key => key + 1);
      }}
      onSubmit={event => {
        event.preventDefault();
        save.mutate({humanTopics: topics});
      }}>
      <SettingRow
        title="Human-only topics"
        description={`A word or short phrase each, like “refund” or “cancel my subscription”. Up to ${ASK_LIMITS.humanTopics}.`}>
        <ListEditor
          key={topicsKey}
          id="f-new-topic"
          label="Add a topic"
          listLabel="Human-only topics"
          hint="Press Enter or Add. Remember to save."
          placeholder="refund"
          items={topics}
          onChange={next => {
            setTopics(next);
            setTopicsError(undefined);
          }}
          max={ASK_LIMITS.humanTopics}
          maxLength={ASK_LIMITS.humanTopic}
          lower
          chips
          error={topicsError}
          disabled={save.isPending}
        />
      </SettingRow>
    </SettingsCard>
  );
}

const HELP_FIELDS = ['helpTitle', 'helpIntro'] as const;

function HelpCenterCard({settings}: {settings: HelpdeskSettingsAdmin}) {
  const initial = (s: HelpdeskSettingsAdmin) => ({helpTitle: s.helpTitle, helpIntro: s.helpIntro});
  const [saved, setSaved] = useState(() => initial(settings));
  const form = useForm(saved, {
    helpTitle: [rules.required('Write the help center’s title, like "How can we help?".'), rules.maxLength(ASK_LIMITS.helpTitle)],
    helpIntro: [rules.maxLength(ASK_LIMITS.helpIntro)],
  });
  const save = useSave(
    HELP_FIELDS,
    next => {
      setSaved(initial(next));
      form.reset(initial(next));
    },
    fields => form.setServerErrors(fields)
  );
  const v = form.values;
  const dirty = v.helpTitle !== saved.helpTitle || v.helpIntro !== saved.helpIntro;

  return (
    <SettingsCard
      title="Help center"
      description="The words at the top of your help center."
      dirty={dirty}
      pending={save.isPending}
      error={save.error}
      names={HELP_FIELDS}
      onUndo={() => form.reset(saved)}
      onSubmit={form.submit(values => save.mutate({helpTitle: values.helpTitle.trim(), helpIntro: values.helpIntro.trim()}))}>
      <SettingRow
        title="Title"
        description={
          <>
            The big heading on <a href="/help/">your help center</a>.
          </>
        }>
        <Field id="f-helpTitle" label="Help center title" error={form.error('helpTitle')}>
          <input {...form.field('helpTitle')} maxLength={ASK_LIMITS.helpTitle} autoComplete="off" placeholder="How can we help?" />
        </Field>
      </SettingRow>
      <SettingRow title="Intro" description="One line under the title.">
        <Field id="f-helpIntro" label="Intro" optional hint="One paragraph: line breaks become spaces." error={form.error('helpIntro')}>
          <textarea {...form.field('helpIntro')} maxLength={ASK_LIMITS.helpIntro} rows={2} placeholder="Search our guides, or ask the assistant." />
        </Field>
      </SettingRow>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ screen --

export function Assistant() {
  const settings = useQuery(helpdeskSettingsQuery);
  const data = settings.data;

  return (
    <div className="app-page screen-assistant">
      <PageHeader
        title="Assistant"
        description="The AI assistant answers customers in the chat from your published articles and snippets only, cites them, and offers a person when it isn’t sure."
      />
      {settings.isPending ? (
        <LoadingBlock rows={6} />
      ) : !data ? (
        <ErrorNote error={settings.error ?? new Error('The settings could not load.')} title="The settings could not load" />
      ) : (
        <>
          {!data.keys.anthropic && (
            <Notice tone="warning" title="The assistant is off">
              Add the secret <code>{data.secretName}</code> in your site’s settings, then come back. Until then, the chat shows
              help-center links and offers a person.
            </Notice>
          )}
          <AssistantCard settings={data} />
          <AnswersCard settings={data} />
          <SpendingCard settings={data} />
          <ChatButtonCard settings={data} />
          <HandoffCard settings={data} />
          <HelpCenterCard settings={data} />
        </>
      )}
    </div>
  );
}
