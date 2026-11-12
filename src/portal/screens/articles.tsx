import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import {type FormEvent, useEffect, useState} from 'react';

import {ARTICLE_STATUS_LABELS, ARTICLE_STATUS_TONES} from '../../lib/helpdesk-tones';
import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  KB_LIMITS,
  type KbArticleInput,
  type KbManageArticle,
  type KbManageArticleRow,
  SLUG_RE,
  slugify,
} from '../../lib/kb-types';
import {api, ApiError, read} from '../api';
import {KB_ALL_ARTICLES, type KbArticleFilters, kbArticleQuery, kbArticlesQuery, kbCategoriesQuery} from '../queries';
import {ago, when} from '../shared';
import {
  ArticleEditor,
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
  LoadingBlock,
  LoadMore,
  Menu,
  type MenuItem,
  Notice,
  PageHeader,
  RadioCards,
  rules,
  SearchInput,
  SegmentedControl,
  Select,
  StatusBadge,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

/** The article form. Every value is a string (`useForm`); `categoryId` is the Select's value. */
const EMPTY_ARTICLE = {
  title: '',
  slug: '',
  categoryId: '',
  excerpt: '',
  body: '',
  status: 'draft',
};
type ArticleForm = typeof EMPTY_ARTICLE;

/** The server lower-cases the slug before it checks it: so do the rules and the save. */
const slugOf = (value: string) => value.trim().toLowerCase();

const BODY_BYTES = new TextEncoder();

/** The SAME limits `src/server/routes/kb-manage.ts` enforces (`KB_LIMITS`, `SLUG_RE`). */
const ARTICLE_RULES = {
  title: [rules.required('Enter a title.'), rules.maxLength(KB_LIMITS.articleTitle)],
  slug: [
    rules.required('Enter the web address, like how-to-descale-a-grinder.'),
    rules.maxLength(KB_LIMITS.articleSlug),
    (value: string) => rules.pattern(SLUG_RE, 'Use lower-case letters, digits and single dashes, like how-to-descale-a-grinder.')(slugOf(value)),
  ],
  categoryId: [rules.required('Pick a category.')],
  excerpt: [rules.maxLength(KB_LIMITS.articleExcerpt)],
  body: [
    rules.required('Write the article.'),
    // The server counts the body as sent, spaces included (not trimmed).
    (value: string) =>
      value.length > KB_LIMITS.articleBody ? `Write the article: 1 to ${KB_LIMITS.articleBody.toLocaleString('en-US')} characters.` : null,
    (value: string) =>
      BODY_BYTES.encode(value).length > KB_LIMITS.articleBodyBytes ? 'This article is too long. Split it into two articles.' : null,
  ],
};

/** How each status reads in the form. */
const STATUS_INFO: Record<ArticleStatus, string> = {
  draft: 'Only people who edit the knowledge base see it.',
  published: 'In the help center and its search at once.',
  archived: 'Hidden from the help center, kept here for reference.',
};

const STATUS_FILTERS: {value: ArticleStatus | ''; label: string}[] = [
  {value: '', label: 'All'},
  ...ARTICLE_STATUSES.map(status => ({value: status, label: ARTICLE_STATUS_LABELS[status]})),
];

const articleUrl = (slug: string) => `/help/articles/${encodeURIComponent(slug)}/`;

/** "82%" of the votes said helpful, or "—" before anyone voted. */
const helpfulShare = (article: KbManageArticleRow) => {
  const votes = article.helpfulCount + article.notHelpfulCount;
  return votes ? `${Math.round((article.helpfulCount / votes) * 100)}%` : '—';
};

const toInput = (values: ArticleForm): KbArticleInput => ({
  title: values.title.trim(),
  slug: slugOf(values.slug),
  categoryId: Number(values.categoryId),
  excerpt: values.excerpt.trim(),
  body: values.body,
  status: values.status as ArticleStatus,
});

/**
 * The editor's Preview tab: the server renders the Markdown exactly as the
 * help center will (`POST /site-api/kb/manage/preview`). Cached per body, so
 * switching tabs back and forth sends nothing new.
 */
function ArticlePreview({markdown}: {markdown: string}) {
  const preview = useQuery({
    queryKey: ['kb-preview', markdown],
    queryFn: () => read<{html: string}>(api.kb.manage.preview.$post({json: {body: markdown}})),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  if (preview.isPending) return <LoadingBlock rows={4} />;
  if (preview.isError) return <ErrorNote error={preview.error} title="The preview could not load" />;
  // The ONE raw-HTML insertion in the dashboard, allowed by the contract: this
  // HTML comes from the server, which renders the Markdown with renderMarkdown()
  // (raw HTML in the input is escaped) and passes it through sanitizeHtml().
  // Never put HTML from anywhere else here.
  return <div className="prose" dangerouslySetInnerHTML={{__html: preview.data.html}} />;
}

/** Holders of `site:kb:edit`: write, publish, archive and delete help articles. */
export function Articles() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const search = useSearch({from: '/articles'});

  const [filter, setFilter] = useState<KbArticleFilters>(KB_ALL_ARTICLES);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<KbManageArticle | 'new' | null>(null);
  // The slug follows the title until someone types in it (never for a saved article: its address is in use).
  const [slugEdited, setSlugEdited] = useState(false);
  const form = useForm(EMPTY_ARTICLE, ARTICLE_RULES);

  const articles = useInfiniteQuery(kbArticlesQuery(filter));
  const categories = useQuery(kbCategoriesQuery);
  const categoryList = categories.data?.categories;
  const noCategories = categoryList !== undefined && categoryList.length === 0;
  const refresh = () => queryClient.invalidateQueries({queryKey: ['kb']});

  const save = useMutation({
    mutationFn: (values: ArticleForm) =>
      editing === 'new' || editing === null
        ? read<{article: KbManageArticle}>(api.kb.manage.articles.$post({json: toInput(values)}))
        : read<{article: KbManageArticle}>(
            api.kb.manage.articles[':id'].$patch({param: {id: String(editing.id)}, json: toInput(values)})
          ),
    onSuccess: ({article}) => {
      toast.success(
        editing === 'new'
          ? article.status === 'published'
            ? `Published “${article.title}”.`
            : `Saved “${article.title}” as a draft.`
          : 'Changes saved.'
      );
      setEditing(null);
      form.reset();
      return refresh();
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      if (Object.keys(err.fields).length) form.setServerErrors(err.fields);
      // 409 slug_taken: the address belongs to another article.
      else if (err.status === 409) form.setServerErrors({slug: err.message});
    },
  });
  const open = useMutation({
    mutationFn: (id: number) => queryClient.fetchQuery(kbArticleQuery(id)),
    onSuccess: ({article}) => {
      form.reset({
        title: article.title,
        slug: article.slug,
        categoryId: String(article.category.id),
        excerpt: article.excerpt,
        body: article.body,
        status: article.status,
      });
      save.reset();
      setSlugEdited(true);
      setEditing(article);
    },
  });
  const setStatus = useMutation({
    mutationFn: ({id, status}: {id: number; status: ArticleStatus; title: string}) =>
      read(api.kb.manage.articles[':id'].$patch({param: {id: String(id)}, json: {status}})),
    onSuccess: (_data, {status, title}) => {
      toast.success(
        status === 'published'
          ? `Published “${title}”.`
          : status === 'archived'
            ? `Archived “${title}”.`
            : `Moved “${title}” back to drafts.`
      );
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => read(api.kb.manage.articles[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });

  // Which ROW is busy: only that row shows it, and no row can be acted on twice.
  const busyKey =
    (open.isPending && open.variables) ||
    (setStatus.isPending && setStatus.variables?.id) ||
    (remove.isPending && remove.variables) ||
    null;
  const rows = articles.data?.pages.flatMap(page => page.articles);
  const rowError = open.error ?? setStatus.error;

  const startNew = () => {
    form.reset({...EMPTY_ARTICLE, categoryId: filter.categoryId === '' ? '' : String(filter.categoryId)});
    save.reset();
    setSlugEdited(false);
    setEditing('new');
  };
  const closeDrawer = () => {
    if (save.isPending) return;
    setEditing(null);
    form.reset();
  };

  // `?new=true` (the overview's "Write an article"): open a blank article once, then drop the flag.
  useEffect(() => {
    if (!search.new) return;
    startNew();
    void navigate({to: '/articles', search: {}, replace: true});
    // Only when the flag appears: startNew and navigate are new on every render.
  }, [search.new]);

  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    setFilter(current => ({...current, q: q.trim()}));
  };
  const filtered = Boolean(filter.status || filter.categoryId !== '' || filter.q);
  const clearFilters = () => {
    setQ('');
    setFilter(KB_ALL_ARTICLES);
  };

  const askDelete = (article: KbManageArticleRow) =>
    void confirm({
      title: `Delete “${article.title}”?`,
      body:
        article.status === 'published'
          ? 'It comes out of the help center and its search at once, and links to it stop working. This can’t be undone; archive it instead to keep it.'
          : 'This can’t be undone; archive it instead to keep it.',
      confirmLabel: 'Delete article',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(article.id),
    }).then(ok => ok && toast.success(`Deleted “${article.title}”.`));

  const menuItems = (article: KbManageArticleRow): MenuItem[] => {
    const change = (status: ArticleStatus) => () => setStatus.mutate({id: article.id, status, title: article.title});
    const items: MenuItem[] = [{label: 'Edit', icon: 'pencil', onSelect: () => open.mutate(article.id)}];
    if (article.status === 'published')
      items.push(
        {label: 'View on site', icon: 'external', onSelect: () => void window.open(articleUrl(article.slug), '_blank', 'noopener,noreferrer')},
        {label: 'Unpublish', icon: 'ban', onSelect: change('draft')}
      );
    else items.push({label: 'Publish', icon: 'check-circle', onSelect: change('published')});
    if (article.status !== 'archived') items.push({label: 'Archive', icon: 'inbox', onSelect: change('archived')});
    items.push('separator', {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(article)});
    return items;
  };

  const columns: Column<KbManageArticleRow>[] = [
    {
      key: 'title',
      header: 'Article',
      cell: article => (
        <div>
          <span className="cell-title">{article.title}</span>
          <span className="cell-sub">/{article.slug}/</span>
        </div>
      ),
    },
    {key: 'category', header: 'Category', hideOnMobile: true, cell: article => article.category.name},
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: article => (
        <StatusBadge tone={ARTICLE_STATUS_TONES[article.status]}>{ARTICLE_STATUS_LABELS[article.status]}</StatusBadge>
      ),
    },
    {
      key: 'helpful',
      header: 'Helpful',
      width: 'shrink',
      align: 'end',
      hideOnMobile: true,
      cell: article => (
        <div>
          <span>{helpfulShare(article)}</span>
          <span className="cell-sub">
            {article.helpfulCount.toLocaleString()} yes · {article.notHelpfulCount.toLocaleString()} no
          </span>
        </div>
      ),
    },
    {
      key: 'views',
      header: 'Views',
      width: 'shrink',
      align: 'end',
      hideOnMobile: true,
      cell: article => article.viewCount.toLocaleString(),
    },
    {
      key: 'updated',
      header: 'Updated',
      width: 'shrink',
      hideOnMobile: true,
      cell: article => (
        <time className="muted" dateTime={article.updatedAt} title={when(article.updatedAt)}>
          {ago(article.updatedAt)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: article =>
        busyKey === article.id ? (
          <IconButton icon="more" label={`Working on “${article.title}”`} size="sm" pending />
        ) : (
          <>
            <IconButton
              icon="pencil"
              label={`Edit “${article.title}”`}
              size="sm"
              disabled={busyKey !== null || save.isPending}
              onClick={() => open.mutate(article.id)}
            />
            <Menu label={`Actions for “${article.title}”`} disabled={busyKey !== null || save.isPending} items={menuItems(article)} />
          </>
        ),
    },
  ];

  const isNew = editing === 'new';
  const saved = editing !== null && editing !== 'new' ? editing : null;
  const saveFailed = save.error && !(save.error instanceof ApiError && (Object.keys(save.error.fields).length || save.error.status === 409));
  const titleField = form.field('title');
  const slugField = form.field('slug');
  const categoryOptions = [
    {value: '', label: categoryList?.length ? 'Pick a category' : 'No categories yet'},
    ...(categoryList ?? []).map(category => ({value: String(category.id), label: category.name})),
  ];

  return (
    <div className="app-page screen-articles">
      <PageHeader
        title="Articles"
        description={
          <>
            Published articles show in the <a href="/help/">help center</a> and its search. Drafts and archived articles are only here.
          </>
        }
        actions={
          <Button icon="plus" onClick={startNew} disabled={save.isPending || noCategories}>
            New article
          </Button>
        }
      />

      {noCategories && (
        <Notice tone="info" title="Add a category first">
          Every article lives in a category. <Link to="/categories">Create one</Link>, then write your first article.
        </Notice>
      )}
      {categories.error && <ErrorNote error={categories.error} title="The categories could not load" />}
      {rowError && <ErrorNote error={rowError} />}

      <div className="toolbar">
        <form role="search" onSubmit={runSearch} noValidate>
          <SearchInput
            label="Find an article by its title"
            placeholder="Words in the title, then Enter"
            value={q}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setQ(event.target.value);
              // The box's clear button: show every article again.
              if (!event.target.value && filter.q) setFilter(current => ({...current, q: ''}));
            }}
          />
        </form>
        <div className="toolbar-group">
          <SegmentedControl
            label="Status"
            options={STATUS_FILTERS}
            value={filter.status}
            onChange={status => setFilter(current => ({...current, status}))}
          />
          <Select
            aria-label="Category"
            value={filter.categoryId === '' ? '' : String(filter.categoryId)}
            onChange={event =>
              setFilter(current => ({...current, categoryId: event.target.value ? Number(event.target.value) : ''}))
            }
            options={[
              {value: '', label: 'All categories'},
              ...(categoryList ?? []).map(category => ({value: String(category.id), label: category.name})),
            ]}
          />
        </div>
      </div>

      <Card flush>
        <DataTable
          caption="Articles"
          columns={columns}
          rows={rows}
          rowKey={article => article.id}
          loading={articles.isPending}
          error={articles.error}
          busyKey={busyKey}
          empty={
            filtered ? (
              <EmptyState
                icon="search"
                title="No articles match"
                action={
                  <Button variant="secondary" onClick={clearFilters}>
                    Show every article
                  </Button>
                }>
                Try other words, another status or another category.
              </EmptyState>
            ) : noCategories ? (
              <EmptyState
                icon="layers"
                title="No articles yet"
                action={
                  <Link className={buttonClass({variant: 'secondary'})} to="/categories">
                    Create a category
                  </Link>
                }>
                Articles live in categories: create one first, then write your first article.
              </EmptyState>
            ) : (
              <EmptyState
                icon="file"
                title="No articles yet"
                action={
                  <Button variant="secondary" icon="plus" onClick={startNew}>
                    New article
                  </Button>
                }>
                Write the answers your customers look for. Published articles show in the help center and its search.
              </EmptyState>
            )
          }
        />
      </Card>
      {articles.error && rows?.length ? <ErrorNote error={articles.error} /> : null}
      <LoadMore query={articles} />

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'New article' : 'Edit article'}
        description={
          isNew
            ? 'Keep it as a draft until it is ready, then publish it.'
            : saved?.status === 'published'
              ? `Changes show in the help center at once. Last reviewed ${ago(saved.lastReviewedAt)}.`
              : `Last reviewed ${ago(saved?.lastReviewedAt ?? null)}.`
        }
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">
              {isNew ? (form.values.status === 'published' ? 'Publish article' : 'Save article') : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-title" label="Title" hint="The question or task, in the customer's words." error={form.error('title')}>
            <input
              {...titleField}
              maxLength={KB_LIMITS.articleTitle}
              autoComplete="off"
              onChange={event => {
                titleField.onChange(event);
                if (!slugEdited) form.set('slug', slugify(event.target.value));
              }}
            />
          </Field>
          <Field
            id="f-slug"
            label="Web address"
            hint={
              saved?.status === 'published'
                ? 'Changing it breaks links to the old address.'
                : `It will be at ${articleUrl(slugOf(String(form.values.slug)) || 'your-article')}`
            }
            error={form.error('slug')}>
            <input
              {...slugField}
              maxLength={KB_LIMITS.articleSlug}
              autoComplete="off"
              spellCheck={false}
              placeholder="how-to-descale-a-grinder"
              onChange={event => {
                slugField.onChange(event);
                setSlugEdited(event.target.value !== '');
              }}
            />
          </Field>
          <Field id="f-categoryId" label="Category" error={form.error('categoryId')}>
            <Select {...form.field('categoryId')} options={categoryOptions} disabled={!categoryList?.length} />
          </Field>
          <Field
            id="f-excerpt"
            label="Summary"
            optional
            hint="One or two sentences, shown under the title in lists."
            error={form.error('excerpt')}>
            <textarea {...form.field('excerpt')} rows={2} maxLength={KB_LIMITS.articleExcerpt} />
          </Field>
          <ArticleEditor
            label="Article"
            hint="Markdown: ## for sections, 1. for steps, **bold** for buttons and labels."
            {...form.field('body')}
            error={form.error('body')}
            maxLength={KB_LIMITS.articleBody}
            renderPreview={markdown => <ArticlePreview markdown={markdown} />}
          />
          <RadioCards
            legend="Status"
            name="status"
            columns={3}
            value={form.values.status as ArticleStatus}
            onChange={status => form.set('status', status)}
            options={ARTICLE_STATUSES.map(status => ({
              value: status,
              title: ARTICLE_STATUS_LABELS[status],
              description: STATUS_INFO[status],
            }))}
          />
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}
