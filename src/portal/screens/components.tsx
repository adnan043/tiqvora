import {useRef, useState} from 'react';

import {
  ArticleEditor,
  Badge,
  BarChart,
  Button,
  Card,
  ChatMessage,
  Checkbox,
  CitationList,
  Composer,
  type ComposerHandle,
  type ComposerMode,
  ConfidenceBadge,
  ConversationListItem,
  type Column,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  Field,
  Icon,
  ICON_NAMES,
  IconButton,
  LoadingBlock,
  Menu,
  Modal,
  Notice,
  PageHeader,
  Person,
  ProgressBar,
  RadioCards,
  type Rating,
  RatingScale,
  rules,
  SearchInput,
  SegmentedControl,
  Select,
  SettingRow,
  Sparkline,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TicketMeta,
  TimelineEvent,
  useConfirm,
  useForm,
  useToast,
} from '../ui';
import type {TicketStatus} from '../../lib/helpdesk-tones';
import {ago} from '../shared';

/**
 * `/components`: the UI kit on one screen, DEV ONLY (the Preview and
 * `npm run dev`; not in a build, see routes.tsx). Every piece here is
 * imported from `../ui`. Build new screens from these; to change how they
 * look, change the tokens (global.css) or the classes (app.css), not a screen.
 *
 * The rows below are sample data for this page only.
 */
type Sample = {id: number; name: string; email: string; plan: string; status: 'active' | 'trial' | 'overdue'};
const SAMPLE: Sample[] = [
  {id: 1, name: 'Maya Patel', email: 'maya@example.com', plan: 'Pro', status: 'active'},
  {id: 2, name: 'Sam Rivera', email: 'sam@example.com', plan: 'Starter', status: 'trial'},
  {id: 3, name: 'Ava Chen', email: 'ava@example.com', plan: 'Pro', status: 'overdue'},
];
const STATUS_TONES = {active: 'success', trial: 'info', overdue: 'warning'} as const;

export function Components() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<'buttons' | 'forms' | 'data' | 'feedback' | 'helpdesk' | 'icons'>('buttons');

  return (
    <div className="app-page">
      <PageHeader
        title="Components"
        description="The pieces every screen is built from. Only you see this page, and only in the Preview."
        actions={<Button icon="plus">Primary action</Button>}
      />
      <Notice tone="info" title="Import from src/portal/ui">
        <p>
          <code>{"import {Button, Card, DataTable} from '../ui';"}</code> Rules for each piece: docs/agent/ui.md.
        </p>
      </Notice>

      <Tabs
        label="Component groups"
        value={tab}
        onChange={setTab}
        items={[
          {value: 'buttons', label: 'Buttons & overlays'},
          {value: 'forms', label: 'Forms'},
          {value: 'data', label: 'Data'},
          {value: 'feedback', label: 'States'},
          {value: 'helpdesk', label: 'Help desk'},
          {value: 'icons', label: 'Icons & colours', count: ICON_NAMES.length},
        ]}>
        {tab === 'buttons' && <ButtonsDemo onToast={toast.success} confirm={confirm} />}
        {tab === 'forms' && <FormsDemo onSaved={() => toast.success('Saved.')} />}
        {tab === 'data' && <DataDemo />}
        {tab === 'feedback' && <FeedbackDemo />}
        {tab === 'helpdesk' && <HelpdeskKitDemo />}
        {tab === 'icons' && <IconsDemo />}
      </Tabs>
    </div>
  );
}

function ButtonsDemo({onToast, confirm}: {onToast: (message: string) => void; confirm: ReturnType<typeof useConfirm>}) {
  const [pending, setPending] = useState(false);
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="kit-section">
      <Card title="Button" description="One primary per view. Pending while it runs; never pressed twice.">
        <div className="kit-row">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="danger">Delete</Button>
          <Button icon="plus">With icon</Button>
          <Button variant="secondary" iconEnd="chevron-down">
            Options
          </Button>
          <Button disabled>Disabled</Button>
          <Button
            pending={pending}
            pendingLabel="Saving…"
            onClick={() => {
              setPending(true);
              window.setTimeout(() => setPending(false), 1500);
            }}>
            Click: pending
          </Button>
        </div>
        <div className="kit-row">
          <Button size="sm">Small</Button>
          <Button size="sm" variant="secondary">
            Small
          </Button>
          <Button size="lg">Large</Button>
          <IconButton icon="pencil" label="Edit" />
          <IconButton icon="trash" label="Delete" variant="secondary" />
          <Menu
            label="More actions"
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: () => onToast('Edit picked.')},
              {label: 'Duplicate', icon: 'copy', onSelect: () => onToast('Duplicate picked.')},
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: () => onToast('Delete picked.')},
            ]}
          />
        </div>
      </Card>
      <Card title="Dialogs, drawers, confirm, toast" description="Native <dialog>: focus trapped, Esc closes, focus returns.">
        <div className="kit-row">
          <Button variant="secondary" onClick={() => setModal(true)}>
            Open a modal
          </Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open a drawer
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void confirm({
                title: 'Delete this item?',
                body: 'It is removed for everyone. This cannot be undone.',
                confirmLabel: 'Delete item',
                pendingLabel: 'Deleting…',
                action: () => new Promise(resolve => window.setTimeout(resolve, 1000)),
              }).then(ok => ok && onToast('Item deleted.'))
            }>
            Confirm a delete
          </Button>
          <Button variant="secondary" onClick={() => onToast('Changes saved.')}>
            Show a toast
          </Button>
        </div>
      </Card>
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Invite a teammate"
        description="They get an email with a link to join."
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModal(false)}>Send invite</Button>
          </>
        }>
        <Field id="kit-invite" label="Email address">
          <input id="kit-invite" type="email" placeholder="name@example.com" />
        </Field>
      </Modal>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Edit customer"
        description="A drawer holds a longer form or a record's details."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDrawer(false)}>
              Cancel
            </Button>
            <Button onClick={() => setDrawer(false)}>Save changes</Button>
          </>
        }>
        <DefinitionList
          items={[
            {label: 'Name', value: 'Maya Patel'},
            {label: 'Email', value: 'maya@example.com'},
            {label: 'Plan', value: <Badge tone="brand">Pro</Badge>},
            {label: 'Status', value: <StatusBadge tone="success">Active</StatusBadge>},
          ]}
        />
      </Drawer>
    </div>
  );
}

function FormsDemo({onSaved}: {onSaved: () => void}) {
  const form = useForm(
    {name: '', email: '', size: 'small', notes: ''},
    {name: [rules.required('Enter a name.'), rules.maxLength(80)], email: [rules.required('Enter an email.'), rules.email()]}
  );
  const [plan, setPlan] = useState<'starter' | 'pro'>('starter');
  const [agree, setAgree] = useState(true);
  const [weekly, setWeekly] = useState(false);
  return (
    <form className="kit-section" noValidate onSubmit={form.submit(() => onSaved())}>
      <Card
        title="Fields"
        description="A visible label, the error under the field in words, shown on blur or submit."
        footer={
          <>
            <Button variant="secondary" onClick={() => form.reset()}>
              Reset
            </Button>
            <Button type="submit">Save</Button>
          </>
        }>
        <div className="form-grid">
          <Field id="f-name" label="Name" error={form.error('name')}>
            <input {...form.field('name')} autoComplete="name" />
          </Field>
          <Field id="f-email" label="Email" hint="We never share it." error={form.error('email')}>
            <input {...form.field('email')} type="email" autoComplete="email" />
          </Field>
          <Field id="f-size" label="Team size (a long list: Select)">
            <Select
              {...form.field('size')}
              options={[
                {value: 'small', label: '1–10 people'},
                {value: 'medium', label: '11–50 people'},
                {value: 'large', label: '51–200 people'},
                {value: 'xl', label: 'More than 200'},
              ]}
            />
          </Field>
          <div className="full">
            <Field id="f-notes" label="Notes" optional>
              <textarea {...form.field('notes')} rows={3} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Choices" description="Five or fewer options: RadioCards. On / off that applies at once: Switch.">
        <div className="form-stack">
          <RadioCards
            legend="Plan"
            name="kit-plan"
            value={plan}
            onChange={setPlan}
            options={[
              {value: 'starter', title: 'Starter', description: 'For one person getting going.'},
              {value: 'pro', title: 'Pro', description: 'For a team, with roles and reports.'},
            ]}
          />
          <Checkbox label="Send me product news" description="About once a month." checked={agree} onChange={setAgree} />
          <Switch label="Weekly summary" description="An email every Monday with last week's numbers." checked={weekly} onChange={setWeekly} />
          <div className="kit-row">
            <SearchInput label="Search customers" placeholder="Search by name" />
            <SegmentedControl
              label="Period"
              value="month"
              onChange={() => undefined}
              options={[
                {value: 'week', label: 'Week'},
                {value: 'month', label: 'Month'},
                {value: 'year', label: 'Year'},
              ]}
            />
          </div>
        </div>
      </Card>
      <Card title="Settings rows">
        <SettingRow title="Public profile" description="Shown to everyone who visits your page.">
          <Switch label="Show my profile" checked onChange={() => undefined} />
        </SettingRow>
        <SettingRow title="Display name" description="How your name appears to others.">
          <Field id="kit-display" label="Display name">
            <input id="kit-display" defaultValue="Maya" />
          </Field>
        </SettingRow>
      </Card>
    </form>
  );
}

function DataDemo() {
  const columns: Column<Sample>[] = [
    {key: 'name', header: 'Customer', cell: row => <Person name={row.name} detail={row.email} />},
    {key: 'plan', header: 'Plan', cell: row => <Badge tone={row.plan === 'Pro' ? 'brand' : 'neutral'}>{row.plan}</Badge>, width: 'shrink'},
    {key: 'status', header: 'Status', cell: row => <StatusBadge tone={STATUS_TONES[row.status]}>{row.status}</StatusBadge>, width: 'shrink'},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: row => <Menu label={`Actions for ${row.name}`} items={[{label: 'Open', icon: 'external', onSelect: () => undefined}]} />,
    },
  ];
  return (
    <div className="kit-section">
      <div className="stat-grid">
        <Stat label="Revenue" icon="trending-up" value="$12,480" trend={{label: '+8%', direction: 'up'}} hint="vs last month">
          <Sparkline values={[4, 6, 5, 8, 7, 9, 12]} label="Revenue rose over the last 7 weeks" />
        </Stat>
        <Stat label="Customers" icon="users" value="25+" hint="First page" />
        <Stat label="Refunds" icon="refresh" value="3" trend={{label: '+1', direction: 'up', good: false}} hint="this week" />
        <Stat label="Loading" icon="clock" value={null} />
      </div>
      <Card title="DataTable" description="Loading, empty and error built in; rows become cards on a phone." flush>
        <DataTable caption="Customers" columns={columns} rows={SAMPLE} rowKey={row => row.id} busyKey={2} />
      </Card>
      <div className="grid-2">
        <Card title="BarChart">
          <BarChart
            label="Sign-ups per day"
            data={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => ({label, value: [3, 5, 4, 8, 6, 2, 4][i]!}))}
          />
        </Card>
        <Card title="ProgressBar, DefinitionList">
          <div className="form-stack">
            <ProgressBar value={62} label="Storage used" />
            <DefinitionList
              items={[
                {label: 'Storage', value: '6.2 GB of 10 GB'},
                {label: 'Renews', value: '1 December'},
              ]}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function FeedbackDemo() {
  return (
    <div className="kit-section">
      <Notice tone="info" title="Info">
        A fact worth knowing.
      </Notice>
      <Notice tone="success" title="Done">
        Your changes are live.
      </Notice>
      <Notice tone="warning" title="Needs attention" action={<Button size="sm" variant="secondary">Fix it</Button>}>
        Your card expires this month.
      </Notice>
      <Notice tone="danger" title="That did not work">
        The server could not be reached. Try again.
      </Notice>
      <div className="grid-2">
        <Card title="Empty state">
          <EmptyState icon="inbox" title="No orders yet" action={<Button icon="plus">Add an order</Button>}>
            Orders show here as customers place them.
          </EmptyState>
        </Card>
        <Card title="Loading">
          <LoadingBlock rows={3} />
        </Card>
      </div>
      <Card title="Badges">
        <div className="kit-row">
          <Badge>Neutral</Badge>
          <Badge tone="brand">Brand</Badge>
          <Badge tone="success" icon="check">
            Success
          </Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="danger">Danger</Badge>
          <Badge tone="info">Info</Badge>
          <StatusBadge tone="success">Active</StatusBadge>
          <StatusBadge tone="warning">Pending</StatusBadge>
          <StatusBadge tone="danger">Suspended</StatusBadge>
          <StatusBadge tone="neutral">Closed</StatusBadge>
        </div>
      </Card>
    </div>
  );
}

function IconsDemo() {
  const swatches = ['accent', 'accent-soft', 'surface', 'card', 'ink', 'muted', 'line', 'success', 'warning', 'danger', 'info'];
  return (
    <div className="kit-section">
      <Card title="Colour tokens" description="Defined once in src/styles/global.css, light and dark. Change --accent to rebrand.">
        <div className="kit-swatches">
          {swatches.map(name => (
            <div key={name} className="kit-swatch">
              <span className={`swatch-${name}`} />
              <span>--{name}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Icons" description={`<Icon name="…" />, ${ICON_NAMES.length} of them. Add more from lucide.dev in ui/icon.tsx.`}>
        <div className="kit-icons">
          {ICON_NAMES.map(name => (
            <div key={name} className="kit-icon">
              <Icon name={name} size={20} />
              {name}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------- help desk pieces (src/portal/ui/chat.tsx, composer.tsx, helpdesk.tsx) ---------- */

const DEMO_CONVERSATIONS = [
  {
    id: 1042,
    customerName: 'Maya Okafor',
    subject: 'Grinder arrived with a cracked hopper',
    preview: 'Hi, the burr grinder from order NW-20931 came today and the hopper lid is cracked along one side.',
    minutesAgo: 4,
    status: 'waiting',
    priority: 'high',
    unread: true,
  },
  {
    id: 1039,
    customerName: 'Tomás Lindqvist',
    subject: 'Change my subscription to every 3 weeks',
    preview: 'Thanks! Could you also swap the Ethiopia Guji for the house blend next time?',
    minutesAgo: 95,
    status: 'open',
    priority: 'normal',
    unread: false,
  },
  {
    id: 1031,
    customerName: 'Priya Raman',
    subject: 'Refund for a double charge',
    preview: 'I can see two charges of $18.50 on 4 Nov for the same order.',
    minutesAgo: 60 * 26,
    status: 'pending',
    priority: 'urgent',
    unread: false,
  },
  {
    id: 1017,
    customerName: 'Jordan Ellis',
    subject: 'Which beans for a moka pot?',
    preview: 'Perfect, the Morning Roast works great. Thank you!',
    minutesAgo: 60 * 24 * 3,
    status: 'solved',
    priority: 'low',
    unread: false,
  },
] as const;

function ConversationListDemo() {
  const [selected, setSelected] = useState<number>(1042);
  // Worked out once, not on every render.
  const [rows] = useState(() => DEMO_CONVERSATIONS.map(c => ({...c, at: new Date(Date.now() - c.minutesAgo * 60_000).toISOString()})));
  return (
    <div role="list" aria-label="Tickets">
      {rows.map(c => (
        <div role="listitem" key={c.id}>
          <ConversationListItem
            customerName={c.customerName}
            subject={c.subject}
            preview={c.preview}
            number={c.id}
            lastMessageAt={c.at}
            ageLabel={ago(c.at)}
            status={c.status}
            priority={c.priority}
            unread={c.unread}
            selected={selected === c.id}
            onSelect={() => setSelected(c.id)}
          />
        </div>
      ))}
    </div>
  );
}

function ComposerDemo() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<ComposerMode>('reply');
  // `handle`: the screen inserts a saved reply at the caret, or focuses the box (keyboard shortcuts).
  const composer = useRef<ComposerHandle>(null);
  // `initialText` + `onTextChange`: a draft kept outside (per ticket on the inbox, with `key`).
  const draft = useRef('');
  const send = async (text: string, how: ComposerMode) => {
    setPending(true);
    setError(undefined);
    try {
      await new Promise(resolve => setTimeout(resolve, 900));
      if (text.toLowerCase().includes('fail')) {
        const message = 'That message did not send. Check your connection and try again.';
        setError(message);
        throw new Error(message);
      }
      toast.success(how === 'note' ? 'Note added.' : 'Reply sent.');
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="form-stack">
      <Composer
        label="Reply to Maya Okafor"
        placeholder="We're sorry about the hopper, we'll send a new lid today."
        modes
        mode={mode}
        onModeChange={setMode}
        pending={pending}
        error={error}
        maxLength={600}
        hint="Enter sends, Shift+Enter adds a line. Type “fail” to see an error."
        tools={
          <Button variant="ghost" size="sm" icon="zap" onClick={() => composer.current?.insert('Thanks for waiting, Maya. ')}>
            Saved replies
          </Button>
        }
        handle={composer}
        initialText={draft.current}
        onTextChange={text => {
          draft.current = text;
        }}
        onSend={send}
      />
      <Composer label="Your message" placeholder="Ask about your order…" disabled onSend={async () => {}} hint="Disabled: the ticket is closed." />
    </div>
  );
}

const SAMPLE_ARTICLE = `## Descaling your Northwind grinder

Coffee oils build up in the burrs over time. Clean them every 4 weeks.

1. Unplug the grinder and empty the hopper.
2. Run a cup of grinder-cleaning tablets through it.
3. Grind 20 g of old beans to clear the residue.`;

function RatingDemo() {
  const [score, setScore] = useState<Rating | null>(null);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  return (
    <Card title="Rating scale" description="RatingScale: a 1–5 score as a radio group. Arrow keys move; each option is read as “4 out of 5, Good”.">
      <form
        noValidate
        className="form-stack"
        onSubmit={event => {
          event.preventDefault();
          if (score === null) {
            setError('Pick a number from 1 to 5.');
            return;
          }
          setSent(true);
        }}>
        <RatingScale
          label="Rate our help"
          value={score}
          onChange={value => {
            setScore(value);
            setError(undefined);
            setSent(false);
          }}
          lowLabel="Very poor"
          highLabel="Great"
          error={error}
        />
        <div className="form-actions">
          <Button type="submit">Send rating</Button>
        </div>
        {sent && score !== null && <Notice tone="success">Thanks for rating us {score} out of 5.</Notice>}
      </form>
      <RatingScale label="Disabled while it sends" value={4} onChange={() => undefined} disabled />
    </Card>
  );
}

function HelpdeskDemo() {
  const [status, setStatus] = useState<TicketStatus>('pending');
  const form = useForm({body: SAMPLE_ARTICLE}, {body: [rules.required('Write the article before you save it.')]});
  return (
    <>
      <Card title="Ticket details" description="TicketMeta: read-only rows, or a control in place for viewers who can change them.">
        <TicketMeta
          number={1042}
          status={status}
          priority="high"
          assignee="Priya Raman"
          customer={{name: 'Daniel Okafor', detail: 'Customer since March'}}
          created="12 Nov, 09:14"
          controls={{
            status: (
              <Select
                aria-label="Ticket status"
                value={status}
                onChange={event => setStatus(event.target.value as TicketStatus)}
                options={[
                  {value: 'waiting', label: 'Waiting on us'},
                  {value: 'open', label: 'Open'},
                  {value: 'pending', label: 'Pending'},
                  {value: 'solved', label: 'Solved'},
                ]}
              />
            ),
          }}
          extra={[{label: 'Page', value: '/help/articles/descaling-your-grinder/'}]}
        />
      </Card>
      <Card title="Article editor" description="ArticleEditor: Markdown with Write / Preview tabs and a character count.">
        <form noValidate onSubmit={form.submit(() => undefined)}>
          <ArticleEditor
            label="Article body"
            hint="Markdown: ## for headings, 1. for steps."
            {...form.field('body')}
            error={form.error('body')}
            renderPreview={markdown =>
              markdown
                .split(/\n{2,}/)
                .map((block, i) => <p key={i} className="kit-preview-block">{block}</p>)
            }
          />
          <div className="form-actions">
            <Button type="submit">Save article</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function HelpdeskKitDemo() {
  return (
    <div className="kit-section">
      <Card title="Conversation" description="ChatMessage (customer, ai, agent, note), TimelineEvent, CitationList and ConfidenceBadge.">
        <div className="chat-thread">
          <ChatMessage sender="customer" author="Jordan Lee" time="10:02">
            Hi! My Northwind subscription box arrived with the wrong grind. Can I swap it for whole bean?
          </ChatMessage>
          <ChatMessage
            sender="ai"
            author="Northwind Assistant"
            time="10:02"
            footer={
              <>
                <CitationList
                  items={[
                    {title: 'Changing your grind size', href: '/help/articles/changing-your-grind-size/'},
                    {title: 'Returns and replacements', href: '/help/articles/returns-and-replacements/'},
                  ]}
                />
                <div className="toolbar">
                  <ConfidenceBadge confidence="medium" />
                </div>
              </>
            }
          >
            Yes. You can change the grind for your next box under Subscription › Preferences [1]. For a box that already
            arrived with the wrong grind, we send a free replacement within 30 days [2].
          </ChatMessage>
          <TimelineEvent time="10:05">Handed off to the team · Ticket #1042 opened</TimelineEvent>
          <ChatMessage sender="note" author="Sam Rivera" time="10:07">
            Checked the order: packing slip says whole bean, so this was our mistake. Replacing at no charge.
          </ChatMessage>
          <TimelineEvent time="10:08">Assigned to Sam Rivera</TimelineEvent>
          <ChatMessage sender="agent" author="Sam Rivera" time="10:09">
            Sorry about that, Jordan! A whole-bean replacement ships today, and your next box is set to whole bean too.
          </ChatMessage>
          <TimelineEvent time="10:15">Status changed to Solved</TimelineEvent>
        </div>
        <div className="toolbar">
          <ConfidenceBadge confidence="high" />
          <ConfidenceBadge confidence="medium" />
          <ConfidenceBadge confidence="low" />
          <ConfidenceBadge confidence="none" />
        </div>
      </Card>
      <Card title="Conversations" description="ConversationListItem: one ticket in the inbox list." flush>
        <ConversationListDemo />
      </Card>
      <Card title="Composer" description="Grows to six lines, then scrolls. Clears only after the send succeeds; a note sits on the warning fill.">
        <ComposerDemo />
      </Card>
      <RatingDemo />
      <HelpdeskDemo />
    </div>
  );
}
