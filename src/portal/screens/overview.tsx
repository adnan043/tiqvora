import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {cloneElement, type ReactElement, type ReactNode} from 'react';

import type {HealthIssue, HelpdeskOverview} from '../../lib/helpdesk-report-types';
import {CUSTOMER_STATUS_LABELS, type WaitingTicket} from '../../lib/helpdesk-tickets';
import type {Abilities} from '../../lib/types';
import {TICKET_STATUS_LABELS, TICKET_STATUS_TONES} from '../../lib/helpdesk-tones';
import {
  firstAuditQuery,
  firstUsersQuery,
  healthQuery,
  helpdeskOverviewQuery,
  helpdeskStatsQuery,
  KB_DRAFTS,
  kbArticlesQuery,
  kbCategoriesQuery,
  siteQuery,
  supportTicketsQuery,
  twoFactorQuery,
} from '../queries';
import {ApiError} from '../api';
import {ago, pageCount, useMe, when} from '../shared';
import {
  Badge,
  buttonClass,
  Card,
  EmptyState,
  ErrorNote,
  Icon,
  type IconName,
  LoadingBlock,
  Notice,
  PageHeader,
  ProgressBar,
  Sparkline,
  Stat,
  StatusBadge,
} from '../ui';

/**
 * `/` of the dashboard: a greeting, the help desk's tiles, what needs attention, a setup
 * checklist for whoever runs the site, then recent activity. Every number is cheap (counters
 * kept on write, ≤ 7 daily rows, a first page; never a count): docs/agent/performance.md.
 *
 * Tiles, each only for who may open it: Open tickets and Resolutions this week (agents, from
 * `/helpdesk/tickets/tiles`); AI answers this week, Hand-off rate and AI spend this month
 * (reports, from `/helpdesk/reports/overview`).
 */

/** A help desk counter for a tile: "1,204"; '—' when it failed; null (a skeleton) while loading. */
const tileValue = (value: number | undefined, failed: boolean) => (failed ? '—' : value === undefined ? null : value.toLocaleString('en'));

const money = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
const weekday = new Intl.DateTimeFormat('en-GB', {weekday: 'short', timeZone: 'UTC'});
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * "Per day: Mon 4, Tue 6, Wed 0": the sparkline's numbers in words (its text equivalent). Short:
 * it is part of the tile's link name, after the label, the number and the hint.
 */
function perDayLabel(overview: HelpdeskOverview) {
  const monday = Date.parse(`${overview.week.from}T00:00:00Z`);
  const days = overview.answeredByDay.map((n, i) => `${weekday.format(new Date(monday + i * 86_400_000))} ${n}`);
  return `Per day: ${days.join(', ')}`;
}

/**
 * A failed read in words. The server's refusals are already plain; a network failure's own
 * message ("Failed to fetch") is not, so it gets the kit's sentence instead.
 */
const plainError = (error: Error) =>
  error instanceof ApiError ? error : new Error("Couldn't load this. Check your connection and try again.");

/** How long a customer has been waiting: "waiting 3 h", "waiting 2 days", "waiting 5 min". */
function waitingFor(since: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (!Number.isFinite(minutes)) return 'waiting';
  if (minutes < 60) return `waiting ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `waiting ${hours} h`;
  const days = Math.floor(hours / 24);
  return `waiting ${days} ${plural(days, 'day', 'days')}`;
}

/**
 * A health item's words and where it is fixed. Copy lives here; the server sends kinds and counts.
 * A row whose screen this viewer can't open (Assistant settings, Files) has no link: "Ask an admin".
 */
function HealthRow({issue, abilities, capCents}: {issue: HealthIssue; abilities: Abilities | undefined; capCents: number | undefined}) {
  const n = `${issue.count.toLocaleString('en')}${issue.more ? '+' : ''}`;
  const many = issue.more || issue.count !== 1;
  // Each link also says what it is about (hidden): "Review" alone repeats down the list.
  const row = (icon: IconName, text: string, link: ReactElement<{children?: ReactNode}>, allowed = true) => (
    <li className="list-row">
      <span className="list-row-icon">
        <Icon name={icon} size={16} />
      </span>
      <div className="list-row-text">
        <p className="list-row-title">{text}</p>
      </div>
      <span className="list-row-end">
        {allowed ? (
          cloneElement(link, {}, link.props.children, <span className="visually-hidden">: {text}</span>)
        ) : (
          <span className="muted">Ask an admin</span>
        )}
      </span>
    </li>
  );
  const settings = Boolean(abilities?.manageHelpdesk);
  const files = Boolean(abilities?.editKnowledge);
  const fix = 'Fix it';
  const review = 'Review';
  switch (issue.kind) {
    case 'assistant_off':
      // Off = no AI key OR a $0 cap. With a cap set, only the key is missing; without one we
      // can't tell whether the key is there too.
      return row(
        'zap',
        capCents !== undefined && capCents > 0
          ? 'The assistant is off: it needs the ANTHROPIC_API_KEY secret'
          : 'The assistant is off: it needs the ANTHROPIC_API_KEY secret, and a monthly cap above $0',
        <Link to="/assistant">Set it up</Link>,
        settings
      );
    case 'cap_reached':
      return row('warning', "This month's AI budget is used up", <Link to="/assistant">{fix}</Link>, settings);
    case 'cap_near':
      return row('warning', `AI spend is at ${issue.count}% of this month's budget`, <Link to="/assistant">{review}</Link>, settings);
    case 'failed_files':
      return row('upload', `${n} ${many ? 'files' : 'file'} failed`, <Link to="/files">{review}</Link>, files);
    case 'no_source':
      return row(
        'search',
        `${n} ${many ? 'questions' : 'question'} this week found no article`,
        <Link to="/analytics" search={{filter: 'no_source'}}>
          {review}
        </Link>
      );
    case 'knowledge_gaps':
      return row(
        'alert',
        `${n} ${many ? 'questions or tickets point' : 'question or ticket points'} to missing or conflicting articles`,
        <Link to="/knowledge-health" search={{type: 'gap'}}>
          {review}
        </Link>
      );
    case 'low_rated':
      return row(
        'trending-down',
        `${n} ${many ? 'articles are' : 'article is'} rated poorly`,
        <Link to="/knowledge-health" search={{type: 'low_rated'}}>
          {review}
        </Link>
      );
    case 'stale_articles':
      return row(
        'clock',
        `${n} ${many ? 'articles need' : 'article needs'} a review`,
        <Link to="/knowledge-health" search={{type: 'stale'}}>
          {review}
        </Link>
      );
  }
}

/** One of the 5 longest-waiting tickets: number, subject, customer, how long, status in words. */
function WaitingRow({ticket}: {ticket: WaitingTicket}) {
  return (
    <li className="list-row">
      <span className="list-row-icon">
        <Icon name="clock" size={16} />
      </span>
      <div className="list-row-text">
        <p className="list-row-title">
          <Link to="/inbox" search={{ticket: ticket.number}}>
            <span className="ticket-number">#{ticket.number}</span> {ticket.subject}
          </Link>
        </p>
        <p className="list-row-sub">
          {ticket.customer} · <time dateTime={ticket.since}>{waitingFor(ticket.since)}</time>
        </p>
      </div>
      <span className="list-row-end">
        <StatusBadge tone={TICKET_STATUS_TONES[ticket.status]}>{TICKET_STATUS_LABELS[ticket.status]}</StatusBadge>
      </span>
    </li>
  );
}

export function Overview() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  const health = useQuery(healthQuery);
  const site = useQuery(siteQuery);
  const twoFactor = useQuery(twoFactorQuery);
  // Under the screens' own query keys, so a save there refreshes these too.
  const users = useQuery({...firstUsersQuery, enabled: Boolean(abilities?.manageUsers)});
  // The knowledge base: published = the categories' counters (kept on write),
  // drafts = the first page of the drafts filter ("20+"). Never a count query.
  const canEditKb = Boolean(abilities?.editKnowledge);
  const categories = useQuery({...kbCategoriesQuery, enabled: canEditKb});
  const drafts = useInfiniteQuery({...kbArticlesQuery(KB_DRAFTS), enabled: canEditKb});
  const published = categories.data ? categories.data.categories.reduce((sum, category) => sum + category.articleCount, 0) : null;
  const firstDrafts = drafts.data?.pages[0];
  const activity = useQuery({...firstAuditQuery, enabled: Boolean(abilities?.readAudit)});
  const recent = activity.data?.events.slice(0, 6) ?? [];
  // The help desk: agents get the ticket counters (kept on write) and the longest-waiting
  // tickets; report holders the assistant's week, the month's spend and the health issues;
  // everyone else, up to three of their own open requests from the first page of My support.
  const isAgent = Boolean(abilities?.useInbox);
  const seesReports = Boolean(abilities?.seeHelpdeskReports);
  const tiles = useQuery({...helpdeskStatsQuery, enabled: isAgent});
  const overview = useQuery({...helpdeskOverviewQuery, enabled: seesReports});
  const o = overview.data;
  const reportValue = (value: (data: HelpdeskOverview) => string) => (o ? value(o) : overview.error ? '—' : null);
  const reportHint = (hint: (data: HelpdeskOverview) => string) => (o ? hint(o) : overview.error ? "Couldn't load" : undefined);
  const resolved = tiles.data ? tiles.data.confirmedThisWeek + tiles.data.assumedThisWeek : undefined;
  const handOff = o && o.questions > 0 ? Math.round((o.handedOff / o.questions) * 100) : null;
  // Only for viewers who may see the assistant's settings: the server leaves `spend` out otherwise.
  const spend = o?.spend;
  const spendPct = spend && spend.capCents > 0 ? Math.round((spend.spentCents / spend.capCents) * 100) : null;
  // The spend tile while loading or failed (we don't know yet), and once loaded only when it came.
  const showSpend = seesReports && (o ? Boolean(spend) : Boolean(abilities?.manageHelpdesk));
  // Knowledge tiles only for an editor who sees no help desk tile (they would have none).
  const showKbTiles = canEditKb && !isAgent && !seesReports;
  const showAttention = isAgent || seesReports;
  const waitingLongest = tiles.data?.waitingLongest ?? [];
  const issues = o?.health ?? [];
  const requests = useInfiniteQuery({...supportTicketsQuery, enabled: abilities !== undefined && !isAgent});
  const openRequests = (requests.data?.pages[0]?.items ?? []).filter(request => request.status !== 'solved').slice(0, 3);
  const tileHint = (hint: string) => (tiles.error ? "Couldn't load" : hint);
  const firstName = viewer?.name?.split(/\s+/)[0];
  // Staff (any ability) see the site's numbers; a customer sees their own requests and account.
  const isStaff = abilities ? Object.values(abilities).some(Boolean) : undefined;

  // The checklist: only steps this person can do, each done from real data.
  const steps: {label: string; detail: string; done: boolean | undefined; to?: string; icon: IconName}[] = [
    {
      label: 'Confirm your email',
      detail: 'So you can always get back in.',
      done: viewer?.emailVerified,
      icon: 'mail',
    },
    {
      label: 'Turn on two-step sign-in',
      detail: 'A code from your phone, so a password alone is not enough.',
      done: twoFactor.data?.enabled,
      to: '/account',
      icon: 'lock',
    },
  ];
  if (abilities?.manageUsers)
    steps.push({
      label: 'Give someone else admin access',
      detail: 'So the site never depends on one person.',
      done: users.data ? users.data.users.filter(user => user.roles.some(role => role === 'admin' || role === 'owner')).length > 1 : undefined,
      to: '/users',
      icon: 'user-plus',
    });
  if (canEditKb) {
    steps.push({
      label: 'Add your first category',
      detail: 'Group articles the way customers look for them.',
      done: categories.data ? categories.data.categories.length > 0 : undefined,
      to: '/categories',
      icon: 'layers',
    });
    steps.push({
      label: 'Publish your first article',
      detail: 'It shows in the help center at once.',
      done: published === null ? undefined : published > 0,
      to: '/articles',
      icon: 'file',
    });
  }
  const done = steps.filter(step => step.done).length;
  const setupLeft = steps.some(step => step.done === false);

  return (
    <div className="app-page screen-overview">
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        description={
          isStaff === false
            ? 'Your requests to our support team, and your account.'
            : `Here is what is happening on ${site.data?.site?.name ?? 'your site'}.`
        }
        actions={
          <>
            <a className={buttonClass({variant: 'secondary'})} href="/">
              <Icon name="globe" size={18} />
              View the website
            </a>
            {canEditKb && (
              <Link className={buttonClass()} to="/articles" search={{new: true}}>
                <Icon name="plus" size={18} />
                Write an article
              </Link>
            )}
          </>
        }
      />

      {me.error && <ErrorNote error={plainError(me.error)} />}
      {health.data && !health.data.siteKey && (
        <Notice tone="info" title="Emails are not sent here">
          This copy has no Site Key, so sign-in codes and password resets are not emailed. The live site has one.
        </Notice>
      )}

      <div className="stat-grid">
        {isAgent && (
          <Stat
            label="Open tickets"
            icon="inbox"
            value={tileValue(tiles.data?.unsolved, Boolean(tiles.error))}
            hint={tileHint(tiles.data ? `Not solved yet · ${tiles.data.waitingOnUs.toLocaleString('en')} waiting on us` : 'Not solved yet')}
            to="/inbox"
          />
        )}
        {seesReports && (
          <Stat
            label="AI answers this week"
            icon="sparkles"
            value={reportValue(x => x.answered.toLocaleString('en'))}
            hint={reportHint(x => `of ${x.questions.toLocaleString('en')} ${plural(x.questions, 'question', 'questions')} since Monday`)}
            to="/analytics">
            {o && <Sparkline values={o.answeredByDay} label={perDayLabel(o)} />}
          </Stat>
        )}
        {isAgent && (
          <Stat
            label="Resolutions this week"
            icon="check-circle"
            value={tileValue(resolved, Boolean(tiles.error))}
            hint={tileHint(
              tiles.data
                ? `${tiles.data.confirmedThisWeek.toLocaleString('en')} confirmed · ${tiles.data.assumedThisWeek.toLocaleString('en')} solved by the team`
                : 'Since Monday'
            )}
            to="/inbox"
            search={{view: 'solved'}}>
            {/* Short: the whole tile is one link, and this is part of its name. */}
            <p className="overview-stat-note">Confirmed: the customer said it's solved.</p>
          </Stat>
        )}
        {seesReports && (
          <Stat
            label="Hand-off rate"
            icon="users"
            value={reportValue(() => (handOff === null ? '—' : `${handOff}%`))}
            hint={reportHint(x =>
              x.questions === 0
                ? 'No questions this week yet'
                : `${x.handedOff.toLocaleString('en')} of ${x.questions.toLocaleString('en')} questions went to a person this week`
            )}
          />
        )}
        {showSpend && (
          <Stat
            label="AI spend this month"
            icon="zap"
            value={reportValue(() => (spend ? money.format(spend.spentCents / 100) : '—'))}
            hint={reportHint(() => (spend && spend.capCents > 0 ? `of ${money.format(spend.capCents / 100)} budget · ${spendPct ?? 0}%` : 'No budget set'))}
            to={abilities?.manageHelpdesk ? '/assistant' : undefined}>
            {spend && spend.capCents > 0 && (
              <ProgressBar
                value={Math.min(spend.spentCents, spend.capCents)}
                max={spend.capCents}
                label="AI spend against this month's budget"
                valueText={`${spendPct ?? 0}%: ${money.format(spend.spentCents / 100)} of ${money.format(spend.capCents / 100)}`}
              />
            )}
          </Stat>
        )}
        {showKbTiles && (
          <Stat
            label="Published articles"
            icon="file"
            value={categories.error ? '—' : published === null ? null : String(published)}
            hint={categories.data ? `In ${categories.data.categories.length} categor${categories.data.categories.length === 1 ? 'y' : 'ies'}` : undefined}
            to="/articles"
          />
        )}
        {showKbTiles && (
          <Stat
            label="Drafts"
            icon="pencil"
            value={drafts.error ? '—' : (pageCount(firstDrafts?.articles, Boolean(firstDrafts?.next)) ?? null)}
            hint="Not in the help center yet"
            to="/articles"
          />
        )}
        {isStaff === false && (
          <Stat
            label="Your requests"
            icon="message-square"
            value={requests.error ? '—' : (pageCount(requests.data?.pages[0]?.items.filter(r => r.status !== 'solved'), Boolean(requests.data?.pages[0]?.nextBefore)) ?? null)}
            hint="Open conversations with our support team"
            to="/support"
          />
        )}
      </div>

      {openRequests.length > 0 && (
        <Card
          title="Your requests"
          description="Your open conversations with our support team."
          flush
          actions={
            <Link className={buttonClass({variant: 'link'})} to="/support">
              View all
            </Link>
          }>
          <ul className="list">
            {openRequests.map(request => (
              <li key={request.number} className="list-row">
                <span className="list-row-icon">
                  <Icon name="message-square" size={16} />
                </span>
                <div className="list-row-text">
                  <p className="list-row-title">
                    <Link to="/support/$ticketId" params={{ticketId: String(request.number)}}>
                      <span className="ticket-number">#{request.number}</span> {request.subject}
                    </Link>
                  </p>
                  <p className="list-row-sub">
                    <time dateTime={request.lastMessageAt}>Last update {ago(request.lastMessageAt)}</time>
                  </p>
                </div>
                <span className="list-row-end">
                  <StatusBadge tone={TICKET_STATUS_TONES[request.status]}>{CUSTOMER_STATUS_LABELS[request.status]}</StatusBadge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid-main-side">
        <div className="overview-main">
          {showAttention && (
            <Card
              title="Needs attention"
              description={isAgent ? 'The customers waiting longest, then what to fix in the help desk.' : 'What to fix in the help desk.'}
              flush>
              {(isAgent && tiles.isPending) || (seesReports && overview.isPending) ? (
                <div className="card-body">
                  <LoadingBlock rows={3} />
                </div>
              ) : (
                <>
                  {tiles.error && (
                    <div className="card-body">
                      <ErrorNote error={plainError(tiles.error)} title="Couldn't load the waiting tickets" />
                    </div>
                  )}
                  {overview.error && (
                    <div className="card-body">
                      <ErrorNote error={plainError(overview.error)} title="Couldn't load the help desk's health" />
                    </div>
                  )}
                  {waitingLongest.length + issues.length > 0 ? (
                    <ul className="list" aria-label="Needs attention">
                      {waitingLongest.map(ticket => (
                        <WaitingRow key={ticket.number} ticket={ticket} />
                      ))}
                      {issues.map(issue => (
                        <HealthRow key={issue.kind} issue={issue} abilities={abilities} capCents={spend?.capCents} />
                      ))}
                    </ul>
                  ) : (
                    !tiles.error &&
                    !overview.error && (
                      <EmptyState
                        icon="check-circle"
                        title="Nothing needs you right now"
                        action={
                          isAgent ? (
                            <Link className={buttonClass({variant: 'secondary'})} to="/inbox">
                              Open the inbox
                            </Link>
                          ) : (
                            <Link className={buttonClass({variant: 'secondary'})} to="/analytics">
                              Open analytics
                            </Link>
                          )
                        }>
                        {isAgent && seesReports
                          ? 'No customer is waiting and the help desk has nothing to fix.'
                          : isAgent
                            ? 'No customer is waiting for a reply.'
                            : 'The help desk has nothing to fix.'}
                      </EmptyState>
                    )
                  )}
                </>
              )}
            </Card>
          )}
          {abilities?.readAudit ? (
            <Card
              title="Recent activity"
              description="Sign-ups, sign-ins and changes, newest first."
              flush
              actions={
                <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to="/activity">
                  View all
                  <Icon name="arrow-right" size={16} />
                </Link>
              }>
              {activity.error ? (
                <div className="card-body">
                  <ErrorNote error={plainError(activity.error)} />
                </div>
              ) : activity.isPending ? (
                <div className="card-body">
                  <LoadingBlock rows={3} />
                </div>
              ) : recent.length ? (
                <ul className="list">
                  {recent.map(event => (
                    <li key={event.id} className="list-row">
                      <span className="list-row-icon">
                        <Icon name="activity" size={16} />
                      </span>
                      <div className="list-row-text">
                        <p className="list-row-title">
                          {event.actor?.name ?? 'System'} <span className="muted">· {event.action.replaceAll('_', ' ')}</span>
                        </p>
                        {event.targetName && event.targetName !== event.actor?.name && <p className="list-row-sub">{event.targetName}</p>}
                      </div>
                      <time className="list-row-end" dateTime={event.createdAt} title={when(event.createdAt)}>
                        {ago(event.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon="activity" title="Nothing yet">
                  Sign-ups and changes will show here as they happen.
                </EmptyState>
              )}
            </Card>
          ) : (
            <Card title="Your account" description="Your name, email, password and devices.">
              <Link className={buttonClass({variant: 'secondary'})} to="/account">
                Open your account
              </Link>
            </Card>
          )}
        </div>

        <Card
          title={setupLeft ? 'Get started' : 'All set'}
          description={`${done} of ${steps.length} done`}
          actions={!setupLeft && <Badge tone="success" icon="check">Done</Badge>}
          flush
          className="checklist-card">
          <div className="card-body checklist-progress">
            <ProgressBar value={done} max={steps.length} label="Setup progress" />
          </div>
          <ul className="list">
            {steps.map(step => {
              const body = (
                <>
                  <span className="checklist-mark" data-done={step.done ? '' : undefined}>
                    <Icon name="check" size={14} />
                  </span>
                  <span className="list-row-text">
                    <span className="list-row-title">
                      <span className="visually-hidden">{step.done ? 'Done: ' : 'To do: '}</span>
                      {step.label}
                    </span>
                    <span className="list-row-sub">{step.detail}</span>
                  </span>
                  {step.to && !step.done && <Icon name="chevron-right" size={16} className="muted" />}
                </>
              );
              return (
                <li key={step.label} className="list-row checklist-row" data-done={step.done ? '' : undefined}>
                  {step.to && !step.done ? (
                    <Link className="checklist-link" to={step.to}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
