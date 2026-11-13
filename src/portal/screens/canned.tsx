import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {useState} from 'react';

import {type CannedReply, TICKET_LIMITS} from '../../lib/helpdesk-tickets';
import {api, ApiError, read} from '../api';
import {savedRepliesQuery} from '../queries';
import {useMe} from '../shared';
import {PLACEHOLDER_RE, SAVED_REPLY_PLACEHOLDERS} from './inbox/saved-replies';
import {
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  LoadMore,
  Menu,
  Notice,
  PageHeader,
  type Rule,
  rules,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const EMPTY = {title: '', body: ''};
type Values = typeof EMPTY;

/** A name as the server stores it (`src/server/routes/canned.ts`), compared without case. */
const nameKey = (title: string) => title.replace(/\s+/g, ' ').trim().toLowerCase();

const PLACEHOLDER_LIST = SAVED_REPLY_PLACEHOLDERS.map(name => `{{${name}}}`).join(' and ');

/** `{{…}}` the inbox doesn't fill in: they would reach the customer exactly as typed. */
const unknownPlaceholder: Rule = value => {
  const unknown = [...value.matchAll(PLACEHOLDER_RE)].map(m => m[1]!).find(name => !(SAVED_REPLY_PLACEHOLDERS as readonly string[]).includes(name));
  return unknown === undefined ? null : `“{{${unknown}}}” isn't filled in, so customers would see it as typed. Use ${PLACEHOLDER_LIST}, or remove it.`;
};

/**
 * The SAME limits `src/server/routes/canned.ts` enforces (TICKET_LIMITS), plus two checks only
 * the team needs: a name another saved reply already has (agents pick by name), and a
 * placeholder the inbox doesn't fill in.
 */
const rulesFor = (others: CannedReply[]) => ({
  title: [
    rules.required('Give the reply a short name, like “Refund on its way”.'),
    rules.maxLength(TICKET_LIMITS.cannedTitle),
    (value: string) =>
      others.some(reply => nameKey(reply.title) === nameKey(value))
        ? 'Another saved reply already has this name. Give this one a name agents can tell apart.'
        : null,
  ],
  body: [rules.required('Write the reply.'), rules.maxLength(TICKET_LIMITS.cannedBody), unknownPlaceholder],
});

/**
 * `/dashboard/saved-replies` (holders of `site:helpdesk:inbox`): the short
 * answers agents insert into a reply from the inbox's composer ("Saved
 * replies"). The team's own list, at most 100. `{{customer.firstName}}` and
 * `{{agent.firstName}}` are filled in when a reply is inserted.
 */
export function CannedReplies() {
  const me = useMe();
  if (me.data?.abilities.useInbox === false) {
    return (
      <div className="app-page">
        <EmptyState
          icon="lock"
          title="Saved replies are for your support team"
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
  return <CannedScreen />;
}

function CannedScreen() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const replies = useInfiniteQuery(savedRepliesQuery(''));
  const rows = replies.data?.pages.flatMap(page => page.replies);
  // The rules see the loaded list (without the reply being edited) for the duplicate-name check.
  const form = useForm(EMPTY, rulesFor((rows ?? []).filter(reply => reply.id !== editing)));
  const refresh = () => queryClient.invalidateQueries({queryKey: ['helpdesk', 'replies']});

  const save = useMutation({
    mutationFn: (values: Values) => {
      const json = {title: values.title.trim(), body: values.body.trim()};
      return editing === 'new'
        ? read<{reply: CannedReply}>(api.helpdesk.canned.$post({json}))
        : read<{reply: CannedReply}>(api.helpdesk.canned[':id'].$patch({param: {id: String(editing)}, json}));
    },
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Saved reply added.' : 'Changes saved.');
      setEditing(null);
      form.reset();
      return refresh();
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const remove = useMutation({
    mutationFn: (id: number) => read(api.helpdesk.canned[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });

  const full = (rows?.length ?? 0) >= TICKET_LIMITS.cannedMax && !replies.hasNextPage;
  const busyId = remove.isPending ? (remove.variables ?? null) : null;

  const startNew = () => {
    form.reset();
    save.reset();
    setEditing('new');
  };
  const startEdit = (reply: CannedReply) => {
    form.reset({title: reply.title, body: reply.body});
    save.reset();
    setEditing(reply.id);
  };
  const closeDrawer = () => {
    if (save.isPending) return;
    setEditing(null);
    form.reset();
  };
  const askDelete = (reply: CannedReply) =>
    void confirm({
      title: `Delete “${reply.title}”?`,
      body: 'Your team can no longer insert it. Replies already sent stay as they are. This can’t be undone.',
      confirmLabel: 'Delete saved reply',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(reply.id),
    }).then(ok => ok && toast.success('Saved reply deleted.'));

  const columns: Column<CannedReply>[] = [
    {
      key: 'reply',
      header: 'Saved reply',
      cell: reply => (
        <div className="canned-text">
          <span className="cell-title">{reply.title}</span>
          <span className="cell-sub canned-body">{reply.body}</span>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: reply =>
        busyId === reply.id ? (
          <IconButton icon="more" label="Working on this saved reply" size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${reply.title}”`}
            disabled={busyId !== null || save.isPending}
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: () => startEdit(reply)},
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(reply)},
            ]}
          />
        ),
    },
  ];

  const isNew = editing === 'new';
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);
  const bodyField = form.field('body');
  // Trimmed, as the server and the rule count it.
  const bodyLength = String(form.values.body).trim().length;
  const near = bodyLength >= TICKET_LIMITS.cannedBody * 0.9;

  return (
    <div className="app-page screen-canned">
      <PageHeader
        title="Saved replies"
        description="Short answers your team inserts into a reply from the inbox, then edits before sending."
        actions={
          <Button icon="plus" onClick={startNew} disabled={save.isPending || full}>
            New saved reply
          </Button>
        }
      />

      {full && <Notice tone="info">You have {TICKET_LIMITS.cannedMax} saved replies, the most you can keep. Delete one to add another.</Notice>}

      <Card flush>
        <DataTable
          caption="Saved replies"
          columns={columns}
          rows={rows}
          rowKey={reply => reply.id}
          loading={replies.isPending}
          error={replies.error}
          busyKey={busyId}
          empty={
            <EmptyState
              icon="copy"
              title="No saved replies yet"
              action={
                <Button variant="secondary" icon="plus" onClick={startNew}>
                  New saved reply
                </Button>
              }>
              Saved replies are short answers your team reuses, like how refunds work or where to find an order number.
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={replies} />

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'New saved reply' : 'Edit saved reply'}
        description="Agents pick it from “Saved replies” in the inbox. It goes into their reply, where they can change it."
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel={isNew ? 'Adding…' : 'Saving…'}>
              {isNew ? 'Add saved reply' : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-title" label="Name" hint="Only your team sees it, in the list." error={form.error('title')}>
            <input {...form.field('title')} autoComplete="off" placeholder="e.g. Refund on its way" />
          </Field>
          <div className="canned-body-field">
            <Field
              id="f-body"
              label="Reply"
              hint={`Plain text. ${PLACEHOLDER_LIST} are filled in when it's inserted.`}
              error={form.error('body')}>
              <textarea
                {...bodyField}
                aria-describedby={`${bodyField['aria-describedby']} f-body-count`}
                rows={8}
                placeholder="e.g. Hi {{customer.firstName}}, your refund is on its way and should reach you in 3 to 5 days."
              />
            </Field>
            <p className="canned-count" id="f-body-count" data-near={near ? '' : undefined}>
              {bodyLength.toLocaleString()} / {TICKET_LIMITS.cannedBody.toLocaleString()} characters
            </p>
          </div>
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}
