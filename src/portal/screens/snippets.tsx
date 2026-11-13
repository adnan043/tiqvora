import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {type FormEvent, useState} from 'react';

import {KB_LIMITS, type KbSnippet, type KbSnippetInput} from '../../lib/kb-types';
import {api, ApiError, read} from '../api';
import {kbSnippetsQuery} from '../queries';
import {ago} from '../shared';
import {
  Button,
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
  PageHeader,
  rules,
  SearchInput,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const EMPTY = {question: '', answer: ''};
type Values = typeof EMPTY;

/** The SAME limits `src/server/routes/kb-manage.ts` enforces (KB_LIMITS). */
const RULES = {
  question: [rules.required('Enter the question, the way a customer would ask it.'), rules.maxLength(KB_LIMITS.snippetQuestion)],
  answer: [rules.required('Enter the answer.'), rules.maxLength(KB_LIMITS.snippetAnswer)],
};

/** The search box's limit (a title-contains filter, like the articles list). */
const SEARCH_MAX = 80;

/**
 * Holders of `site:kb:edit`: short questions and answers the assistant can
 * use (`/site-api/kb/manage/snippets`). Not shown on the public help center.
 */
export function Snippets() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const form = useForm(EMPTY, RULES);
  const snippets = useInfiniteQuery(kbSnippetsQuery(q));
  const refresh = () => queryClient.invalidateQueries({queryKey: ['kb']});

  const save = useMutation({
    mutationFn: (values: Values) => {
      const json: KbSnippetInput = {question: values.question.trim(), answer: values.answer.trim()};
      return editing === 'new'
        ? read<{snippet: KbSnippet}>(api.kb.manage.snippets.$post({json}))
        : read<{snippet: KbSnippet}>(api.kb.manage.snippets[':id'].$patch({param: {id: String(editing)}, json}));
    },
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Snippet added.' : 'Changes saved.');
      setEditing(null);
      form.reset();
      return refresh();
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const remove = useMutation({
    mutationFn: (id: number) => read(api.kb.manage.snippets[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });

  const rows = snippets.data?.pages.flatMap(page => page.snippets);
  const busyId = remove.isPending ? (remove.variables ?? null) : null;

  const search = (event: FormEvent) => {
    event.preventDefault();
    setQ(draft.trim().slice(0, SEARCH_MAX));
  };
  const startNew = () => {
    form.reset();
    save.reset();
    setEditing('new');
  };
  const startEdit = (snippet: KbSnippet) => {
    form.reset({question: snippet.question, answer: snippet.answer});
    save.reset();
    setEditing(snippet.id);
  };
  const closeDrawer = () => {
    if (save.isPending) return;
    setEditing(null);
    form.reset();
  };
  const askDelete = (snippet: KbSnippet) =>
    void confirm({
      title: 'Delete this snippet?',
      body: `“${snippet.question}” stops being used by the assistant at once. This can’t be undone.`,
      confirmLabel: 'Delete snippet',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(snippet.id),
    }).then(ok => ok && toast.success('Snippet deleted.'));

  const columns: Column<KbSnippet>[] = [
    {
      key: 'question',
      header: 'Question',
      cell: snippet => (
        <div className="snippets-text">
          <span className="cell-title">{snippet.question}</span>
          <span className="cell-sub snippets-answer">{snippet.answer}</span>
        </div>
      ),
    },
    {key: 'updated', header: 'Updated', width: 'shrink', hideOnMobile: true, cell: snippet => ago(snippet.updatedAt)},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: snippet =>
        busyId === snippet.id ? (
          <IconButton icon="more" label="Working on this snippet" size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${snippet.question}”`}
            disabled={busyId !== null || save.isPending}
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: () => startEdit(snippet)},
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(snippet)},
            ]}
          />
        ),
    },
  ];

  const isNew = editing === 'new';
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);
  const answerField = form.field('answer');
  const answerLength = String(form.values.answer).length;
  const near = answerLength >= KB_LIMITS.snippetAnswer * 0.9;

  return (
    <div className="app-page screen-snippets">
      <PageHeader
        title="Snippets"
        description="Short answers the assistant can use, for questions too small for an article. They don’t show on the help center."
        actions={
          <Button icon="plus" onClick={startNew} disabled={save.isPending}>
            New snippet
          </Button>
        }
      />

      <div className="toolbar">
        <form className="snippets-search" role="search" onSubmit={search} noValidate>
          <SearchInput
            label="Search snippets"
            placeholder="Search questions, then Enter"
            value={draft}
            maxLength={SEARCH_MAX}
            autoComplete="off"
            onChange={event => {
              setDraft(event.target.value);
              // The box's clear button: show every snippet again.
              if (!event.target.value && q) setQ('');
            }}
          />
        </form>
      </div>

      <Card flush>
        <DataTable
          caption="Snippets"
          columns={columns}
          rows={rows}
          rowKey={snippet => snippet.id}
          loading={snippets.isPending}
          error={snippets.error}
          busyKey={busyId}
          empty={
            q ? (
              <EmptyState
                icon="search"
                title="No snippets match"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDraft('');
                      setQ('');
                    }}>
                    Clear the search
                  </Button>
                }>
                Nothing matches “{q}”. Try fewer or different words.
              </EmptyState>
            ) : (
              <EmptyState
                icon="layers"
                title="No snippets yet"
                action={
                  <Button variant="secondary" icon="plus" onClick={startNew}>
                    New snippet
                  </Button>
                }>
                Add the quick questions customers ask, like opening hours or delivery times, or import them from a CSV file.
              </EmptyState>
            )
          }
        />
      </Card>
      <LoadMore query={snippets} />

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'New snippet' : 'Edit snippet'}
        description="The assistant can quote this answer when a customer asks this question."
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel={isNew ? 'Adding…' : 'Saving…'}>
              {isNew ? 'Add snippet' : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-question" label="Question" error={form.error('question')}>
            <input {...form.field('question')} autoComplete="off" maxLength={KB_LIMITS.snippetQuestion} placeholder="Do you ship to Canada?" />
          </Field>
          <div className="snippets-answer-field">
            <Field id="f-answer" label="Answer" hint="Plain text, as you would say it to a customer." error={form.error('answer')}>
              <textarea {...answerField} aria-describedby={`${answerField['aria-describedby']} f-answer-count`} rows={8} />
            </Field>
            <p className="snippets-count" id="f-answer-count" data-near={near ? '' : undefined}>
              {answerLength.toLocaleString()} / {KB_LIMITS.snippetAnswer.toLocaleString()} characters
            </p>
          </div>
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}
