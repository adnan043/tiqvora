import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {type ArticleRef, LOW_RATED_MIN_VOTES, type TopReport, type TopWeek} from '../../../lib/helpdesk-report-types';
import {helpdeskTopQuery} from '../../queries';
import {useMe, whenZoned} from '../../shared';
import {buttonClass, Card, type Column, DataTable, EmptyState, Icon, Notice, SegmentedControl} from '../../ui';

/**
 * Analytics › Knowledge: this or last UTC week's rankings from the nightly job
 * (`/site-api/helpdesk/reports/top`): questions that found no article, the articles the
 * assistant used most, and the lowest-rated articles (all-time thumbs, ≥ 5 votes, the highest
 * share of "not helpful" first).
 * Open issues (gaps, stale and poorly rated articles) live in Knowledge health.
 */

const number = new Intl.NumberFormat('en-GB');
const longDay = new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeZone: 'UTC'});

const WEEK_OPTIONS: {value: TopWeek; label: string}[] = [
  {value: 'current', label: 'This week'},
  {value: 'previous', label: 'Last week'},
];

/** A ranking row with its place (1 = first): the row's key, since a gone article has no id. */
type Ranked<T> = T & {rank: number};
type Unanswered = Ranked<TopReport['unanswered'][number]>;
type MostUsed = Ranked<TopReport['mostUsed'][number]>;
type LowestRated = Ranked<TopReport['lowestRated'][number]>;
const ranked = <T,>(rows: T[] | undefined): Ranked<T>[] | undefined => rows?.map((row, i) => ({...row, rank: i + 1}));

/** An article on the public help center (a new tab), or words when it is no longer published. */
function ArticleCell({article}: {article: ArticleRef | null}) {
  if (!article) return <span className="muted">An article that is no longer published</span>;
  return (
    <a className="cell-title" href={`/help/articles/${encodeURIComponent(article.slug)}/`} target="_blank" rel="noopener noreferrer">
      {article.title}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** A new tab, like the article links above it: the report stays where it was. */
const helpCenter = (
  <a className={buttonClass({variant: 'secondary'})} href="/help/" target="_blank" rel="noopener noreferrer">
    Open your help center
    <Icon name="external" size={16} />
    <span className="visually-hidden"> (opens in a new tab)</span>
  </a>
);

export function KnowledgeTab({week, onWeek}: {week: TopWeek; onWeek: (next: TopWeek) => void}) {
  const me = useMe();
  const canEdit = Boolean(me.data?.abilities.editKnowledge);
  const top = useQuery(helpdeskTopQuery(week));
  const data = top.data;
  const loading = top.isPending;
  const error = top.error;
  const period = week === 'current' ? 'this week' : 'last week';
  // Not worked out yet: the empty tables say so, never "every question found an article".
  const notYet = data?.updatedAt === null;
  const notYetState = (
    <EmptyState icon="clock" title="Not worked out yet">
      {week === 'current' ? 'This shows after the first nightly run this week.' : 'Last week was not worked out.'}
    </EmptyState>
  );

  const unansweredColumns: Column<Unanswered>[] = [
    {key: 'question', header: 'Question', cell: row => <span className="cell-title">{row.question}</span>},
    {key: 'asked', header: 'Times asked', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.asked)}</span>},
    ...(canEdit
      ? [
          {
            key: 'write',
            header: 'Write an article',
            actions: true,
            cell: (row: Unanswered) => (
              <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to="/articles" search={{new: true}}>
                <Icon name="plus" size={16} />
                Write an article<span className="visually-hidden"> for “{row.question}”</span>
              </Link>
            ),
          } satisfies Column<Unanswered>,
        ]
      : []),
  ];

  const usedColumns: Column<MostUsed>[] = [
    {key: 'article', header: 'Article', cell: row => <ArticleCell article={row.article} />},
    {key: 'answered', header: 'Answers', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.answered)}</span>},
  ];

  const ratedColumns: Column<LowestRated>[] = [
    {key: 'article', header: 'Article', cell: row => <ArticleCell article={row.article} />},
    {
      key: 'helpful',
      header: 'Found helpful',
      align: 'end',
      width: 'shrink',
      cell: row => {
        const votes = row.helpful + row.notHelpful;
        return <span className="analytics-number">{votes > 0 ? `${Math.round((row.helpful / votes) * 100)}%` : '—'}</span>;
      },
    },
    {
      key: 'votes',
      header: 'Votes',
      align: 'end',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => <span className="analytics-number">{number.format(row.helpful + row.notHelpful)}</span>,
    },
    ...(canEdit
      ? [
          {
            key: 'edit',
            header: 'Edit',
            actions: true,
            cell: (row: LowestRated) =>
              row.article ? (
                <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to="/articles" search={{edit: row.article.id}}>
                  <Icon name="pencil" size={16} />
                  Edit<span className="visually-hidden"> “{row.article.title}”</span>
                </Link>
              ) : null,
          } satisfies Column<LowestRated>,
        ]
      : []),
  ];

  return (
    <div className="analytics-tab">
      <div className="toolbar">
        <SegmentedControl label="Week" value={week} onChange={onWeek} options={WEEK_OPTIONS} />
        <Link className={buttonClass({variant: 'secondary'})} to="/knowledge-health">
          <Icon name="check-circle" size={18} />
          Open Knowledge health
        </Link>
      </div>
      <p className="analytics-tab-note">
        Most-used counts questions whose best match was the article. Ratings are the article page’s thumbs, all time. Open issues are in
        Knowledge health.
        {data?.week && ` Week of ${longDay.format(new Date(`${data.week}T00:00:00Z`))}.`}
        {data?.updatedAt && ` Worked out ${whenZoned(data.updatedAt)}.`}
      </p>

      {/* `updatedAt` null = the nightly job has not worked this week out (an empty week it has
          worked out has a time and shows the empty tables). */}
      {data && data.updatedAt === null && (
        week === 'current' ? (
          <Notice tone="info" title="No rankings for this week yet">
            Rankings are worked out every night. This week’s first ones appear tomorrow.
          </Notice>
        ) : (
          <Notice tone="info" title="No rankings for last week">
            Rankings are worked out every night, and none were worked out for last week.
          </Notice>
        )
      )}

      <Card title="Questions without an article" description={`Asked ${period} and answered by no article, most asked first.`} flush>
        <DataTable
          caption="Questions without an article"
          columns={unansweredColumns}
          rows={ranked(data?.unanswered)}
          rowKey={row => row.rank}
          loading={loading}
          error={error}
          empty={
            notYet ? notYetState : (
            <EmptyState
              icon="check-circle"
              title="Every question found an article"
              action={
                <Link className={buttonClass({variant: 'secondary'})} to="/analytics" search={{}}>
                  See all questions
                </Link>
              }>
              Questions the help center couldn’t answer {period} show here.
            </EmptyState>
            )
          }
        />
      </Card>

      <div className="grid-2">
        <Card title="Most-used articles" description={`The best match of questions answered ${period}.`} flush>
          <DataTable
            caption="Most-used articles"
            columns={usedColumns}
            rows={ranked(data?.mostUsed)}
            rowKey={row => row.rank}
            loading={loading}
            error={error}
            empty={
              notYet ? (
                notYetState
              ) : (
                <EmptyState icon="file" title={week === 'current' ? 'No answers yet this week' : 'No answers last week'} action={helpCenter}>
                  Articles the assistant answers from show here.
                </EmptyState>
              )
            }
          />
        </Card>

        <Card title="Lowest-rated articles" description={`The highest share of “not helpful” votes first, all time, from articles with at least ${LOW_RATED_MIN_VOTES} votes.`} flush>
          <DataTable
            caption="Lowest-rated articles"
            columns={ratedColumns}
            rows={ranked(data?.lowestRated)}
            rowKey={row => row.rank}
            loading={loading}
            error={error}
            empty={
              notYet ? notYetState : (
              <EmptyState
                icon="trending-up"
                title="No article has enough ratings yet"
                action={
                  canEdit ? (
                    <Link className={buttonClass({variant: 'secondary'})} to="/articles">
                      View articles
                    </Link>
                  ) : (
                    helpCenter
                  )
                }>
                {`An article is ranked once it has ${LOW_RATED_MIN_VOTES} votes on its page.`}
              </EmptyState>
              )
            }
          />
        </Card>
      </div>
    </div>
  );
}
