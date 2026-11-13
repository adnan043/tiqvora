import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type KeyboardEvent, useEffect, useRef, useState} from 'react';

import {
  IMPORT_EMPTY_MESSAGE,
  IMPORT_TOO_LONG_MESSAGE,
  LAUNCH_BAND_LABELS,
  launchScore,
  type LaunchScore,
  oneLine,
  parseImport,
  questionOf,
  TEST_LAB_LIMITS,
  TEST_OUTCOME_LABELS,
  type TestCaseRow,
  type TestExpect,
  type TestRunView,
} from '../../lib/test-lab';
import {api, ApiError, read} from '../api';
import {helpdeskSettingsQuery, testCasesQuery, testLabArticlesQuery, testRunQuery} from '../queries';
import {ago, when} from '../shared';
import {
  Button,
  Card,
  CitationList,
  type Column,
  ConfidenceBadge,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  LoadMore,
  Menu,
  Notice,
  PageHeader,
  ProgressBar,
  RadioCards,
  rules,
  SearchInput,
  Stat,
  StatusBadge,
  type Tone,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

/**
 * Holders of `site:helpdesk:settings`: the owner's own questions, asked of the assistant
 * before customers do (`/site-api/helpdesk/test-lab`). A run asks every question in
 * background batches and scores it; its AI calls count toward the assistant's monthly cap.
 */

const BAND_TONES: Record<LaunchScore['band'], Tone> = {ready: 'success', almost: 'warning', not_ready: 'danger', none: 'neutral'};

/** The same words as Assistant and Knowledge health: the key is an owner secret, the cap is in Assistant. */
const AI_OFF_MESSAGE = 'Add the ANTHROPIC_API_KEY secret in your site settings and set a monthly cap above $0 in Assistant.';

const STOP_REASONS: Record<NonNullable<TestRunView['stopReason']>, string> = {
  cap: 'The run stopped: this month’s spending cap is reached. Raise it in Assistant or wait until next month.',
  ai_off: AI_OFF_MESSAGE,
  stalled: 'The run didn’t finish. Run it again.',
  not_started: 'The run didn’t finish. Run it again.',
  error: 'The run didn’t finish. Run it again.',
};

const EXPECT_OPTIONS: {value: TestExpect; title: string; description: string}[] = [
  {value: 'answer', title: 'Expect an answer', description: 'Passes when the assistant answers, citing the article you pick (or any article).'},
  {value: 'handoff', title: 'Expect a hand-off', description: 'Passes when the assistant hands the question to a person, like a refund request.'},
];

const money = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
const runTime = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The SAME rules the server applies (`questionOf`, src/lib/test-lab.ts): never cut, an error instead. */
const QUESTION_RULES = [
  rules.required('Type the question, the way a customer would ask it.'),
  (value: string) => {
    const q = questionOf(value);
    return typeof q === 'string' ? q : null;
  },
];

/** The import box's problem, from the SAME parser the server runs (`parseImport`), or null. */
function importProblem(text: string): string | null {
  if (text.length > TEST_LAB_LIMITS.importChars) return IMPORT_TOO_LONG_MESSAGE;
  const {questions, errors} = parseImport(text);
  if (errors.length > 1) {
    const more = errors.slice(1, 6).map(error => error.line);
    return `${errors[0]!.message} Also check line${more.length > 1 ? 's' : ''} ${more.join(', ')}${errors.length > 6 ? ' and more' : ''}.`;
  }
  if (errors.length) return errors[0]!.message;
  return questions.length ? null : IMPORT_EMPTY_MESSAGE;
}

/** Non-blank lines of a paste: with `parseImport`'s questions, how many were repeats within it. */
const filledLines = (text: string) => text.split(/\r\n|\r|\n/).filter(line => oneLine(line)).length;

/**
 * Focus goes back to what opened a drawer once it closes: the drawers unmount (so the native
 * dialog can't return it). Call the returned function just before opening.
 */
function useReturnFocus(open: boolean) {
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open || !trigger.current) return;
    const element = trigger.current;
    trigger.current = null;
    if (element.isConnected) element.focus();
  }, [open]);
  return () => {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
}

/** Pass / Fail / Skipped / Not run, with the reason under it (TEST_OUTCOME_LABELS: one set of words). */
function Result({row}: {row: TestCaseRow}) {
  if (!row.lastOutcome) return <StatusBadge tone="neutral">Not run</StatusBadge>;
  const reason = TEST_OUTCOME_LABELS[row.lastOutcome];
  const [label, tone]: [string, Tone] = row.lastPassed === true ? ['Pass', 'success'] : row.lastPassed === false ? ['Fail', 'danger'] : ['Skipped', 'neutral'];
  return (
    <div>
      <StatusBadge tone={tone}>{label}</StatusBadge>
      {row.lastPassed !== true && reason && <span className="cell-sub">{reason}</span>}
    </div>
  );
}

export function TestLab() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const cases = useInfiniteQuery(testCasesQuery);
  const runQuery = useQuery(testRunQuery);
  const settings = useQuery(helpdeskSettingsQuery);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['helpdesk', 'test-lab']});

  const first = cases.data?.pages[0];
  const rows = cases.data?.pages.flatMap(page => page.items);
  const total = first?.total ?? 0;
  // The run query polls while running; the cases page has the run as of its own read.
  const run = runQuery.data ? runQuery.data.run : (first?.run ?? null);
  const running = run?.state === 'running';
  // The score is the server's (`page.score`: the latest run that scored something); only while a
  // run is going is it recomputed here, live. `scoreRun` is the run it came from, when known.
  const score = !first ? null : running ? launchScore(run, total) : first.score;
  const scoreRun = running ? run : first?.run && first.run.done > 0 ? first.run : null;
  const aiOff = settings.data ? !settings.data.keys.anthropic || settings.data.monthlyCapCents === 0 : false;

  // When a run stops running, the cases have their new results: load them, and say how it went.
  const lastState = useRef(run?.state);
  useEffect(() => {
    if (lastState.current === 'running' && run && run.state !== 'running') {
      void queryClient.invalidateQueries({queryKey: testCasesQuery.queryKey});
      if (run.state === 'done') toast.success(`Run finished: ${run.passed} of ${run.done} passed.`);
    }
    lastState.current = run?.state;
  }, [run?.state]);

  const start = useMutation({
    mutationFn: () => read<{run: TestRunView}>(api.helpdesk['test-lab'].runs.$post()),
    onSuccess: data => {
      queryClient.setQueryData(testRunQuery.queryKey, data);
      void refresh();
    },
    onError: err => {
      // 409 run_active: a run is already going; just show it.
      if (err instanceof ApiError && err.code === 'run_active') void refresh();
    },
  });
  const startCode = start.error instanceof ApiError ? start.error.code : undefined;
  // The server says the assistant is off (the key or the cap changed since the settings loaded).
  const showAiOff = aiOff || startCode === 'ai_off';
  const startError = start.error && startCode !== 'run_active' && startCode !== 'ai_off' ? start.error : null;
  const stop = useMutation({
    mutationFn: (id: number) => read<{run: TestRunView}>(api.helpdesk['test-lab'].runs[':id'].cancel.$post({param: {id: String(id)}})),
    onSuccess: data => queryClient.setQueryData(testRunQuery.queryKey, data),
    onSettled: refresh,
  });
  const askStop = (id: number) =>
    void confirm({
      title: 'Stop the run?',
      body: 'Questions already being asked still finish.',
      confirmLabel: 'Stop run',
      pendingLabel: 'Stopping…',
      action: () => stop.mutateAsync(id),
    });

  const remove = useMutation({
    mutationFn: (id: number) => read(api.helpdesk['test-lab'].cases[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });
  const askDelete = (row: TestCaseRow) =>
    void confirm({
      title: 'Delete this question?',
      body: `“${row.question}” and its last result are removed.`,
      confirmLabel: 'Delete question',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(row.id),
    }).then(ok => ok && toast.success('Question deleted.'));

  const [editing, setEditingState] = useState<TestCaseRow | 'new' | null>(null);
  const [importing, setImportingState] = useState(false);
  const rememberTrigger = useReturnFocus(editing !== null || importing);
  const setEditing = (next: TestCaseRow | 'new' | null) => {
    if (next !== null) rememberTrigger();
    setEditingState(next);
  };
  const setImporting = (next: boolean) => {
    if (next) rememberTrigger();
    setImportingState(next);
  };
  const busyKey = remove.isPending ? (remove.variables ?? null) : null;

  // Shown as text next to the button (never only a tooltip). Loading: disabled, nothing to say yet.
  const loadingRun = !first || runQuery.isPending || settings.isPending;
  const runDisabledReason = loadingRun
    ? null
    : total === 0
      ? 'Add a question first.'
      : running
        ? 'A run is going: its progress is below.'
        : showAiOff
          ? 'The assistant is off: see the note below.'
          : null;

  const columns: Column<TestCaseRow>[] = [
    {
      key: 'question',
      header: 'Question',
      cell: row => (
        <Button variant="link" className="test-lab-question" onClick={() => setEditing(row)}>
          {row.question}
        </Button>
      ),
    },
    {
      key: 'expected',
      header: 'Expected',
      cell: row =>
        row.expect === 'handoff' ? (
          'Hand-off'
        ) : row.expectedArticle ? (
          <span>{row.expectedArticle.title}</span>
        ) : (
          <span className="muted">Any</span>
        ),
    },
    {key: 'result', header: 'Result', cell: row => <Result row={row} />},
    {
      key: 'confidence',
      header: 'Confidence',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => (row.lastConfidence ? <ConfidenceBadge confidence={row.lastConfidence} /> : <span className="muted">—</span>),
    },
    {
      key: 'last',
      header: 'Last run',
      width: 'shrink',
      hideOnMobile: true,
      cell: row =>
        row.lastRunAt ? (
          <time className="muted" dateTime={row.lastRunAt} title={when(row.lastRunAt)}>
            {ago(row.lastRunAt)}
          </time>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: row => (
        <Menu
          label={`Actions for “${row.question}”`}
          disabled={busyKey !== null}
          items={[
            {label: running ? 'View' : 'Edit', icon: running ? 'eye' : 'pencil', onSelect: () => setEditing(row)},
            'separator',
            {label: 'Delete', icon: 'trash', danger: true, disabled: running, onSelect: () => askDelete(row)},
          ]}
        />
      ),
    },
  ];

  return (
    <div className="app-page screen-test-lab">
      <PageHeader
        title="Test Lab"
        description="Ask the assistant your own questions before customers do. Each run uses the assistant's monthly spending cap."
        actions={
          <div className="test-lab-run">
            <Button
              icon="flask"
              pending={start.isPending}
              pendingLabel="Starting…"
              disabled={loadingRun || runDisabledReason !== null}
              aria-describedby={runDisabledReason ? 'test-lab-run-reason' : undefined}
              onClick={() => start.mutate()}>
              Run all
            </Button>
            {runDisabledReason && (
              <p className="field-hint" id="test-lab-run-reason">
                {runDisabledReason}
              </p>
            )}
          </div>
        }
      />

      {/* One notice at a time: the most useful first. */}
      {showAiOff ? (
        <Notice tone="warning" title="The assistant is off">
          Tests need the assistant. {AI_OFF_MESSAGE} <Link to="/assistant">Open Assistant</Link>
        </Notice>
      ) : startError ? (
        <ErrorNote error={startError} title="The run didn’t start" />
      ) : run && (run.state === 'stopped' || run.state === 'failed') ? (
        <Notice tone="warning" title={run.state === 'stopped' ? 'The run stopped' : 'The run failed'}>
          {STOP_REASONS[run.stopReason ?? 'error']}
        </Notice>
      ) : run?.state === 'cancelled' ? (
        <Notice tone="info" title="You stopped the last run">
          {run.done} of {run.total} questions were checked. Run all to test every question again.
        </Notice>
      ) : null}

      {run && running && (
        <Card title="Checking now…" description="Questions are asked in batches of ten in the background. You can leave this page.">
          <div className="form-stack">
            <ProgressBar value={run.done} max={Math.max(run.total, 1)} label={`${run.done} of ${run.total} questions checked`} />
            <p className="muted">
              {run.done} of {run.total} checked so far.
            </p>
            <div>
              <Button variant="secondary" icon="x" pending={stop.isPending} pendingLabel="Stopping…" onClick={() => askStop(run.id)}>
                Stop
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ScoreCard score={score} run={scoreRun} total={total} error={cases.error} />

      <Card
        title="Test questions"
        description={first ? `${plural(total, 'question')} of up to ${TEST_LAB_LIMITS.cases}.` : undefined}
        actions={
          <>
            <Button variant="secondary" icon="plus" disabled={running || total >= TEST_LAB_LIMITS.cases} onClick={() => setEditing('new')}>
              Add question
            </Button>
            <Button variant="secondary" disabled={running || total >= TEST_LAB_LIMITS.cases} onClick={() => setImporting(true)}>
              Import
            </Button>
          </>
        }
        flush>
        {running && rows?.length ? (
          <div className="test-lab-hint">
            <p className="field-hint">Editing is paused while the run is going. Wait for the run to finish.</p>
          </div>
        ) : null}
        <DataTable
          caption="Test questions"
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          loading={cases.isPending}
          error={cases.error}
          busyKey={busyKey}
          empty={
            <EmptyState
              icon="flask"
              title="No test questions yet"
              action={
                <Button icon="plus" onClick={() => setEditing('new')}>
                  Add question
                </Button>
              }>
              Add the questions your customers ask most, or paste a list with Import above.
            </EmptyState>
          }
        />
      </Card>
      {cases.error && rows?.length ? <ErrorNote error={cases.error} /> : null}
      <LoadMore query={cases} />

      {editing !== null && (
        <CaseDrawer key={editing === 'new' ? 'new' : editing.id} editing={editing} locked={running} onClose={() => setEditing(null)} />
      )}
      {importing && <ImportDrawer onClose={() => setImporting(false)} />}
    </div>
  );
}

/**
 * The launch score as the kit's `Stat`. `run` is the run the score came from (null when the
 * server's score is from a run this page doesn't have): its time and cost, never another run's.
 * A read error shows once, in the table.
 */
function ScoreCard({score, run, total, error}: {score: LaunchScore | null; run: TestRunView | null; total: number; error: Error | null}) {
  const live = run?.state === 'running';
  const scored = score && score.band !== 'none' && score.score !== null ? {...score, score: score.score} : null;
  const at = run ? (run.finishedAt ?? run.createdAt) : null;
  const value = !score ? (error ? '—' : null) : scored ? `${scored.score}/100${live ? ' so far' : ''}` : '—';
  const hint = !score
    ? undefined
    : scored
      ? [
          `${scored.passed} of ${scored.ran} passed`,
          at ? `${live ? 'started' : 'last run'} ${runTime.format(new Date(at))}` : null,
          run ? `cost ${money.format(run.costCents / 100)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : live
        ? 'Checking now…'
        : 'Run your tests to get a score.';
  return (
    <div className="test-lab-score">
      <Stat label="Ready to launch?" icon="flask" value={value} hint={hint}>
        {scored && (
          <>
            <StatusBadge tone={BAND_TONES[scored.band]}>{LAUNCH_BAND_LABELS[scored.band]}</StatusBadge>
            <ProgressBar value={scored.score} label={`Score: ${scored.score} out of 100`} />
          </>
        )}
        <p className="field-hint">
          Questions passed, weighted by how many you tested.{' '}
          {total < 20 ? 'Add at least 20 questions for a full score.' : '20 or more can earn a full score.'}
        </p>
      </Stat>
    </div>
  );
}

// ---------------------------------------------------------------- drawers --

type CaseForm = {question: string; expect: string; expectedArticleId: string};

function CaseDrawer({editing, locked, onClose}: {editing: TestCaseRow | 'new'; locked: boolean; onClose: () => void}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const row = editing === 'new' ? null : editing;
  const initial: CaseForm = {
    question: row?.question ?? '',
    expect: row?.expect ?? 'answer',
    expectedArticleId: row?.expectedArticle ? String(row.expectedArticle.id) : '',
  };
  const form = useForm(initial, {question: QUESTION_RULES});
  const [picked, setPicked] = useState<{id: number; title: string} | null>(row?.expectedArticle ?? null);
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const handoff = form.values.expect === 'handoff';
  const articles = useQuery({...testLabArticlesQuery(searched), enabled: !handoff && !locked});
  const articleField = form.field('expectedArticleId');
  const articleError = form.error('expectedArticleId');

  // Add or edit: straight into the Question field (after the dialog has placed its own focus).
  useEffect(() => {
    if (!locked) document.getElementById('f-question')?.focus();
  }, []);

  /** What the form says, as the server will store it. */
  const wanted = (values: CaseForm) => {
    const q = questionOf(values.question);
    return {
      question: typeof q === 'string' ? values.question : q.question,
      expect: values.expect as TestExpect,
      expectedArticleId: values.expect === 'handoff' || !values.expectedArticleId ? null : Number(values.expectedArticleId),
    };
  };
  /**
   * An edit sends ONLY what changed: every PATCH clears the case's last result, and an unchanged
   * expected article that has since been archived would be refused.
   */
  const changes = (values: CaseForm) => {
    const next = wanted(values);
    const out: Partial<ReturnType<typeof wanted>> = {};
    if (!row) return out;
    if (next.question !== row.question) out.question = next.question;
    if (next.expect !== row.expect) out.expect = next.expect;
    if (next.expectedArticleId !== (row.expectedArticle?.id ?? null)) out.expectedArticleId = next.expectedArticleId;
    return out;
  };

  const save = useMutation({
    mutationFn: (values: CaseForm) =>
      row
        ? read<{case: TestCaseRow}>(api.helpdesk['test-lab'].cases[':id'].$patch({param: {id: String(row.id)}, json: changes(values)}))
        : read<{case: TestCaseRow}>(api.helpdesk['test-lab'].cases.$post({json: wanted(values)})),
    onSuccess: () => {
      toast.success(row ? 'Question saved.' : 'Question added.');
      void queryClient.invalidateQueries({queryKey: ['helpdesk', 'test-lab']});
      onClose();
    },
    onError: err => {
      if (err instanceof ApiError && Object.keys(err.fields).length) form.setServerErrors(err.fields);
    },
  });
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length) ? save.error : null;
  const submit = (values: CaseForm) => {
    // Nothing changed: nothing to send (a save would only wipe the last result).
    if (row && Object.keys(changes(values)).length === 0) return onClose();
    save.mutate(values);
  };

  const pick = (article: {id: number; title: string} | null) => {
    setPicked(article);
    form.set('expectedArticleId', article ? String(article.id) : '');
  };
  // Enter in the search box searches; it never submits the drawer's form.
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    setSearched(q.trim());
  };

  const results = articles.data?.items;
  const sourceItems = (row?.lastSources ?? []).filter(source => source.url).map(source => ({title: source.title, href: source.url}));

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title={row ? 'Test question' : 'Add a question'}
      description={row ? (row.lastRunAt ? `Last asked ${ago(row.lastRunAt)}.` : 'Not asked yet. Run all to ask it.') : 'Ask it the way a customer would.'}
      onSubmit={form.submit(submit)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            {locked ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={locked}>
            {row ? 'Save changes' : 'Add question'}
          </Button>
        </>
      }>
      <div className="form-stack">
        {row?.lastOutcome && (
          <section className="test-lab-section">
            <h3>Last answer</h3>
            <DefinitionList
              items={[
                {label: 'Result', value: <Result row={row} />},
                {label: 'Confidence', value: row.lastConfidence ? <ConfidenceBadge confidence={row.lastConfidence} /> : '—'},
              ]}
            />
            {row.lastAnswer ? <p className="test-lab-answer">{row.lastAnswer}</p> : <p className="muted">No answer was written.</p>}
            <CitationList items={sourceItems} />
          </section>
        )}

        {locked && <Notice tone="info">Wait for the run to finish to change this question.</Notice>}

        <Field id="f-question" label="Question" hint={`Up to ${TEST_LAB_LIMITS.question} characters.`} error={form.error('question')}>
          <textarea {...form.field('question')} rows={3} disabled={locked} placeholder="Can I change my delivery address?" />
        </Field>

        <RadioCards
          legend="What should happen"
          name="expect"
          value={form.values.expect as TestExpect}
          // The picked article is kept while "Expect a hand-off" is chosen (switching back restores it);
          // a hand-off case is SENT with no article (`wanted`), as the server requires.
          onChange={value => form.set('expect', value)}
          options={EXPECT_OPTIONS.map(option => ({...option, disabled: locked}))}
          columns={2}
        />

        {!handoff && (
          <fieldset className="test-lab-picker" disabled={locked}>
            <legend>Expected article</legend>
            <p className="field-hint">
              {picked ? (
                <>
                  Passes only when the answer cites “{picked.title}”.{' '}
                  <Button variant="link" size="sm" onClick={() => pick(null)}>
                    Any article
                  </Button>
                </>
              ) : (
                'Any article: passes when the assistant answers with a source. Pick one to be stricter.'
              )}
            </p>
            {/* The kit's SearchInput takes no ref: register its input (server errors focus it). */}
            <div ref={node => articleField.ref(node?.querySelector('input') ?? null)}>
              <SearchInput
                label="Find a published article by its title"
                placeholder="Refunds"
                value={q}
                maxLength={80}
                autoComplete="off"
                aria-invalid={articleError ? true : undefined}
                aria-describedby={articleError ? 'test-lab-search-hint f-expectedArticleId-error' : 'test-lab-search-hint'}
                onChange={event => {
                  setQ(event.target.value);
                  if (!event.target.value && searched) setSearched('');
                }}
                onKeyDown={onSearchKey}
              />
            </div>
            <p className="field-hint" id="test-lab-search-hint">
              Type words from the title, then press Enter.
            </p>
            {articles.isPending && !locked ? (
              <LoadingBlock rows={2} />
            ) : articles.error ? (
              <ErrorNote error={articles.error} />
            ) : results && results.length === 0 ? (
              <p className="muted">{searched ? 'No published article has those words in its title.' : 'No published articles yet.'}</p>
            ) : results ? (
              <ul className="list test-lab-results" aria-label="Published articles">
                {results.map(article => (
                  <li key={article.id} className="list-row">
                    <span className="list-row-text">{article.title}</span>
                    <Button
                      variant={picked?.id === article.id ? 'primary' : 'secondary'}
                      size="sm"
                      icon={picked?.id === article.id ? 'check' : undefined}
                      aria-pressed={picked?.id === article.id}
                      onClick={() => pick(picked?.id === article.id ? null : article)}>
                      {picked?.id === article.id ? 'Picked' : 'Pick'}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {articleError && (
              <p className="field-error" id="f-expectedArticleId-error" role="alert">
                {articleError}
              </p>
            )}
          </fieldset>
        )}
        {saveFailed && <ErrorNote error={saveFailed} />}
      </div>
    </Drawer>
  );
}

function ImportDrawer({onClose}: {onClose: () => void}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useForm({text: ''}, {text: [(value: string) => importProblem(value)]});
  useEffect(() => {
    document.getElementById('f-text')?.focus();
  }, []);
  const save = useMutation({
    mutationFn: async (text: string) => {
      const result = await read<{added: number; duplicates: number; overLimit: number; repeated?: number}>(
        api.helpdesk['test-lab'].cases.import.$post({json: {text}})
      );
      // The server drops repeats inside the paste before counting: count them here with the SAME
      // parser (unless the server says).
      return {...result, repeated: result.repeated ?? Math.max(0, filledLines(text) - parseImport(text).questions.length)};
    },
    onSuccess: ({added, duplicates, overLimit, repeated}) => {
      const parts = [`Added ${plural(added, 'question')}.`];
      const skipped = duplicates + repeated;
      if (skipped) {
        const what = duplicates && repeated ? 'already there or repeated' : duplicates ? 'already there' : 'repeated in the list';
        parts.push(`${skipped.toLocaleString('en-US')} ${skipped === 1 ? 'was' : 'were'} ${what}.`);
      }
      if (overLimit) parts.push(`${overLimit.toLocaleString('en-US')} didn’t fit: the limit is ${TEST_LAB_LIMITS.cases}.`);
      toast.success(parts.join(' '));
      void queryClient.invalidateQueries({queryKey: ['helpdesk', 'test-lab']});
      onClose();
    },
    onError: err => {
      if (err instanceof ApiError && Object.keys(err.fields).length) form.setServerErrors(err.fields);
    },
  });
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length) ? save.error : null;
  const count = parseImport(form.values.text).questions.length;

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title="Import questions"
      description="Paste a list from a spreadsheet, a document or your inbox. Questions already in the list are skipped."
      onSubmit={form.submit(values => save.mutate(values.text))}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" pending={save.isPending} pendingLabel="Importing…">
            Import {count > 0 ? plural(count, 'question') : 'questions'}
          </Button>
        </>
      }>
      <div className="form-stack">
        <Field
          id="f-text"
          label="Questions"
          hint={`One question per line, up to ${TEST_LAB_LIMITS.importLines}. ${plural(count, 'question')} so far.`}
          error={form.error('text')}>
          <textarea {...form.field('text')} rows={12} placeholder={'Where is my order?\nCan I pay by invoice?'} />
        </Field>
        {saveFailed && <ErrorNote error={saveFailed} />}
      </div>
    </Drawer>
  );
}
