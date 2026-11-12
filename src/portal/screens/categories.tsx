import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {KB_LIMITS, type KbCategoryInput, type KbManageCategory, RESERVED_CATEGORY_SLUGS, SLUG_RE, slugify} from '../../lib/kb-types';
import {api, ApiError, read} from '../api';
import {kbCategoriesQuery} from '../queries';
import {
  Button,
  Card,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  Icon,
  ICON_NAMES,
  type IconName,
  IconButton,
  Menu,
  PageHeader,
  rules,
  Select,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const EMPTY = {name: '', slug: '', description: '', icon: 'file', position: ''};
type Values = typeof EMPTY;

/** The server lower-cases the slug before it checks it: so do the rules and the save. */
const slugOf = (value: string) => value.trim().toLowerCase();

/** The SAME limits `src/server/routes/kb-manage.ts` enforces (KB_LIMITS). */
const RULES = {
  name: [rules.required('Enter a name, like "Orders & shipping".'), rules.maxLength(KB_LIMITS.categoryName)],
  slug: [
    rules.required('Enter the web address part, like "orders-and-shipping".'),
    rules.maxLength(KB_LIMITS.categorySlug),
    (value: string) => rules.pattern(SLUG_RE, 'Use lower-case letters, numbers and single dashes, like "orders-and-shipping".')(slugOf(value)),
    (value: string) =>
      (RESERVED_CATEGORY_SLUGS as readonly string[]).includes(slugOf(value))
        ? 'That address is used by the help center. Pick another slug.'
        : null,
  ],
  description: [rules.maxLength(KB_LIMITS.categoryDescription)],
  position: [rules.pattern(/^\d{1,4}$/, 'Use a whole number from 0 to 9999, like 3.')],
};

const isIcon = (name: string): name is IconName => (ICON_NAMES as string[]).includes(name);
const iconOf = (name: string): IconName => (isIcon(name) ? name : 'file');
const ICON_OPTIONS = ICON_NAMES.map(name => {
  const words = name.replace(/-/g, ' ');
  return {value: name, label: words.charAt(0).toUpperCase() + words.slice(1)};
});

const categoryUrl = (category: KbManageCategory) => `/help/${encodeURIComponent(category.slug)}/`;

/** Holders of `site:kb:edit`: the help center's categories (`/site-api/kb/manage/categories`). */
export function Categories() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const categories = useQuery(kbCategoriesQuery);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  // The slug follows the name until someone types in it (or the category exists already).
  const [slugTouched, setSlugTouched] = useState(false);
  const form = useForm(EMPTY, RULES);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['kb']});

  const save = useMutation({
    mutationFn: (values: Values) => {
      const json: KbCategoryInput = {
        name: values.name.trim(),
        slug: slugOf(values.slug),
        description: values.description.trim(),
        icon: values.icon,
        ...(values.position.trim() ? {position: Number(values.position.trim())} : {}),
      };
      return editing === 'new'
        ? read<{category: KbManageCategory}>(api.kb.manage.categories.$post({json}))
        : read<{category: KbManageCategory}>(api.kb.manage.categories[':id'].$patch({param: {id: String(editing)}, json}));
    },
    onSuccess: ({category}) => {
      toast.success(editing === 'new' ? `Added “${category.name}”.` : 'Changes saved.');
      setEditing(null);
      form.reset();
      return refresh();
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      if (Object.keys(err.fields).length) form.setServerErrors(err.fields);
      // 409 slug_taken: the slug field is what to change.
      else if (err.status === 409) form.setServerErrors({slug: err.message});
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => read(api.kb.manage.categories[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });

  const rows = categories.data?.categories;
  const busyId = remove.isPending ? (remove.variables ?? null) : null;

  const nextPosition = () => String(rows?.length ? Math.max(...rows.map(row => row.position)) + 1 : 0);
  const startNew = () => {
    form.reset({...EMPTY, position: nextPosition()});
    save.reset();
    setSlugTouched(false);
    setEditing('new');
  };
  const startEdit = (category: KbManageCategory) => {
    form.reset({
      name: category.name,
      slug: category.slug,
      description: category.description,
      icon: iconOf(category.icon),
      position: String(category.position),
    });
    save.reset();
    setSlugTouched(true);
    setEditing(category.id);
  };
  const closeDrawer = () => {
    if (save.isPending) return;
    setEditing(null);
    form.reset();
  };
  const askDelete = (category: KbManageCategory) =>
    void confirm({
      title: `Delete “${category.name}”?`,
      body:
        category.totalArticles > 0
          ? `It still holds ${category.totalArticles} article${category.totalArticles === 1 ? '' : 's'}: move or delete them first, then delete the category.`
          : 'It comes off the help center at once. This can’t be undone.',
      confirmLabel: 'Delete category',
      pendingLabel: 'Deleting…',
      // A 409 (articles still in it) shows its message in the dialog.
      action: () => remove.mutateAsync(category.id),
    }).then(ok => ok && toast.success(`Deleted “${category.name}”.`));

  const nameField = form.field('name');
  const slugField = form.field('slug');

  const columns: Column<KbManageCategory>[] = [
    {
      key: 'name',
      header: 'Category',
      cell: category => (
        <div className="categories-name">
          <span className="categories-icon" aria-hidden="true">
            <Icon name={iconOf(category.icon)} size={18} />
          </span>
          <span className="categories-text">
            <span className="cell-title">{category.name}</span>
            <span className="cell-sub">/help/{category.slug}/</span>
          </span>
        </div>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      hideOnMobile: true,
      cell: category =>
        category.description ? <span className="categories-description">{category.description}</span> : <span className="muted">—</span>,
    },
    {key: 'published', header: 'Published', width: 'shrink', align: 'end', cell: category => category.articleCount.toLocaleString()},
    {key: 'total', header: 'All articles', width: 'shrink', align: 'end', cell: category => category.totalArticles.toLocaleString()},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: category =>
        busyId === category.id ? (
          <IconButton icon="more" label={`Working on “${category.name}”`} size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${category.name}”`}
            disabled={busyId !== null || save.isPending}
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: () => startEdit(category)},
              {
                label: 'View on site',
                icon: 'external',
                onSelect: () => void window.open(categoryUrl(category), '_blank', 'noopener,noreferrer'),
              },
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(category)},
            ]}
          />
        ),
    },
  ];

  const isNew = editing === 'new';
  const saveFailed = save.error && !(save.error instanceof ApiError && (Object.keys(save.error.fields).length || save.error.status === 409));

  return (
    <div className="app-page screen-categories">
      <PageHeader
        title="Categories"
        description={
          <>
            How the <a href="/help/">help center</a> is organised. Every article belongs to one category.
          </>
        }
        actions={
          <Button icon="plus" onClick={startNew} disabled={save.isPending || categories.isPending}>
            New category
          </Button>
        }
      />

      <Card flush>
        <DataTable
          caption="Categories"
          columns={columns}
          rows={rows}
          rowKey={category => category.id}
          loading={categories.isPending}
          error={categories.error}
          busyKey={busyId}
          empty={
            <EmptyState
              icon="layers"
              title="No categories yet"
              action={
                <Button variant="secondary" icon="plus" onClick={startNew}>
                  New category
                </Button>
              }>
              Categories group your articles on the help center, like “Orders & shipping” or “Account & billing”.
            </EmptyState>
          }
        />
      </Card>

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'New category' : 'Edit category'}
        description={isNew ? 'Articles you publish in it are listed under it on the help center.' : 'Changes show on the help center at once.'}
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel={isNew ? 'Adding…' : 'Saving…'}>
              {isNew ? 'Add category' : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-name" label="Name" error={form.error('name')}>
            <input
              {...nameField}
              autoComplete="off"
              maxLength={KB_LIMITS.categoryName}
              placeholder="Orders & shipping"
              onChange={event => {
                nameField.onChange(event);
                if (!slugTouched) form.set('slug', slugify(event.target.value, KB_LIMITS.categorySlug));
              }}
            />
          </Field>
          <Field
            id="f-slug"
            label="Web address"
            hint={
              isNew
                ? 'Made from the name; change it if you like. Lower-case letters, numbers and dashes.'
                : 'Changing it changes the category’s link: old links stop working.'
            }
            error={form.error('slug')}>
            <input
              {...slugField}
              autoComplete="off"
              spellCheck={false}
              maxLength={KB_LIMITS.categorySlug}
              placeholder="orders-and-shipping"
              onChange={event => {
                setSlugTouched(true);
                slugField.onChange(event);
              }}
            />
          </Field>
          <Field id="f-description" label="Description" optional hint="One line under the name on the help center." error={form.error('description')}>
            <textarea {...form.field('description')} maxLength={KB_LIMITS.categoryDescription} rows={3} />
          </Field>
          <div className="form-grid">
            <Field id="f-icon" label="Icon" hint="Shown on its card." error={form.error('icon')}>
              <div className="categories-icon-pick">
                <span className="categories-icon" aria-hidden="true">
                  <Icon name={iconOf(String(form.values.icon))} size={18} />
                </span>
                <Select {...form.field('icon')} options={ICON_OPTIONS} />
              </div>
            </Field>
            <Field id="f-position" label="Position" hint="Lower numbers come first." error={form.error('position')}>
              <input {...form.field('position')} inputMode="numeric" autoComplete="off" />
            </Field>
          </div>
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}
