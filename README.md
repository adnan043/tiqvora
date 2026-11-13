# AI Help Desk & Knowledge Base

A help desk for one business, on one site: a public **help center** of articles, an **AI
assistant** in a chat window that answers from those articles, a **hand-off to a person** when
it can't, an **inbox** where your team answers, **analytics** on what customers ask, a weekly
**knowledge health** check with article drafts for a person to review, and a **Test Lab** to try
the assistant before customers do.

Built on the Web App template: [Astro](https://astro.build) pages, a [Hono](https://hono.dev)
backend at `/site-api`, a React dashboard at `/dashboard`, and Postgres through
[Prisma ORM 7](https://www.prisma.io), all on one Cloudflare Worker. One project, one build, one
deploy. Sign-in, roles and the activity log come from the template.

This file is for you, the site's owner, and for the AI agent that changes the site for you.

## Contents

- [What it does](#what-it-does)
- [Where each feature lives](#where-each-feature-lives)
- [Turn the assistant on](#turn-the-assistant-on) (the key, the spending cap, the models)
- [Limits, said plainly](#limits-said-plainly)
- [Privacy](#privacy)
- [What owners usually change](#what-owners-usually-change)
- [Who can do what](#who-can-do-what)
- [Not included](#not-included)
- [Sample data](#sample-data)
- [Background jobs](#background-jobs)
- [For your AI](#for-your-ai)
- Running it on your own computer: [Quick start](#quick-start) · [Requirements](#requirements) ·
  [Setting up](#setting-up-step-by-step) · [Local development mode](#local-development-mode) ·
  [Create your admin account](#create-your-admin-account) · [Scripts](#scripts) ·
  [Project structure](#project-structure) · [Building on it](#building-on-it) · [Tests](#tests) ·
  [Staying up to date](#staying-up-to-date) · [Troubleshooting](#troubleshooting) · [FAQ](#faq)
- [On the platform](#on-the-platform)

## What it does

1. **You write the knowledge.** Articles (Markdown, in categories) and short snippets (a question
   and its answer). Write them in the dashboard, paste Markdown, or import a CSV of questions and
   answers. Only **published** articles and snippets are used anywhere public.
2. **Customers help themselves** at `/help/`: browse categories, search, read articles, say if an
   article helped.
3. **The assistant answers in a chat window** on the site's public pages. It answers only from your
   published articles and snippets, and links the articles it used. When nothing matches, when it
   isn't sure enough, or when the topic is one you marked "human only", it offers a person instead.
4. **"Talk to a person"** turns the chat into a ticket. The customer signs in (or creates an
   account), adds a note, and the conversation so far goes with it.
5. **Your team answers in the Inbox**: queues, assignment, priority, internal notes, saved replies,
   an AI summary at the top of each ticket, and who else is looking at the same ticket.
6. **Customers follow the reply in My support** (`/dashboard/support`), reply back, mark it solved,
   and rate it 1–5.
7. **Analytics** shows how many questions came in, how many the assistant answered, which were
   handed to a person or found no article, what customers rated helpful, and what it cost.
8. **Knowledge health** lists what your help center is missing or getting wrong. A weekly check
   runs every **Monday at 07:30 in your time zone** (Dashboard › Assistant › Weekly check) over the
   past 7 days and files:
   - **Gaps**: questions asked at least twice that found no article, or were answered with low
     confidence (grouped by their words, or by the weak article; at most 50 a week);
   - **Stale** articles: published and not reviewed for 180 days;
   - **Low rated** articles: 10 or more votes, and 30% or more "not helpful".

   **Conflicts** come from solved tickets (below): an agent's answer that contradicts the article
   the assistant cited. The weekly check makes **no AI calls** and writes no drafts by itself. Open
   an issue to see why it's there (sample questions, votes, the ticket); press **Write a draft**
   to have the assistant write one (3 tries per issue). **Accept** saves your edited text as a
   **draft article** in Articles, never published: a person publishes it. It updates the issue's
   own draft article only if nobody edited it since; otherwise, and always for a published
   article, it makes a new draft. **Dismiss** hides the issue, and the same finding isn't flagged
   again for 90 days.
9. **Article drafts from solved tickets.** When a ticket is solved (by an agent or the customer),
   the assistant reads the conversation and, if the agent explained something reusable, writes a
   draft (a new article, or an edit to the article it cited) and files it in Knowledge health as a
   gap or a conflict, "Found by: A solved ticket". A one-off fix gets no draft. Nothing is
   published without a person pressing Accept and then Publish.
10. **Test Lab** (Dashboard › Test Lab): a list of questions your customers ask (up to 500; add
    them one by one or paste up to 100 at a time), each expecting **an answer citing an article**
    (or any answer) or **a hand-off to a person**. **Run all** asks every question through the real
    assistant in the background, 10 at a time, and shows each answer, what it cited and whether
    it passed, plus a **Ready to launch** score (0–100: "Ready to launch" needs 85+ on 10 or more
    questions). Test runs are not in Analytics or the weekly check.

## Where each feature lives

| Feature | Screen / URL | Code |
| --- | --- | --- |
| Help center (public) | `/help/`, `/help/<category>/`, `/help/articles/<slug>/`, `/help/search/` | `src/pages/help/`, `src/server/routes/kb.ts`, `src/server/kb/` |
| Articles, categories, snippets | Dashboard › Articles, Categories, Snippets | `src/portal/screens/articles.tsx`, `categories.tsx`, `snippets.tsx`; `src/server/routes/kb-manage.ts` |
| Import (Markdown, CSV) | Dashboard › Import | `src/portal/screens/import.tsx`, `src/lib/kb-import.ts`; `POST /site-api/kb/manage/import` |
| Chat window (widget) | every public page (not sign-in, dashboard or checkout) | `src/lib/helpdesk-widget.ts`, `src/lib/helpdesk-handoff.ts`, mounted in `src/layouts/Base.astro` |
| The assistant's answers | `POST /site-api/helpdesk/ask` | `src/server/routes/helpdesk.ts`, `src/server/ai/` (retrieve, prompt, provider, answer, usage) |
| Assistant settings | Dashboard › Assistant | `src/portal/screens/assistant.tsx`, `src/server/routes/helpdesk-settings.ts`, `src/server/kb/settings.ts` |
| AI models and prices | Dashboard › Assistant › Answers | `src/lib/ai-models.ts` |
| Hand-off to a ticket | "Talk to a person" in the chat | `src/server/routes/support.ts` (`/helpdesk/conversations`) |
| My support (customer) | Dashboard › My support, `/dashboard/support/<number>` | `src/portal/screens/support.tsx`, `src/server/routes/support.ts` (`/helpdesk/my`) |
| Inbox (staff) | Dashboard › Inbox | `src/portal/screens/inbox.tsx`, `src/portal/screens/inbox/ticket.tsx`, `src/server/routes/inbox.ts`, `src/server/helpdesk/state.ts` |
| AI ticket summary | top of each ticket in the Inbox | `src/server/helpdesk/summary.ts` |
| Saved replies | Dashboard › Saved replies, and the picker in a ticket | `src/portal/screens/canned.tsx`, `src/portal/screens/inbox/saved-replies.tsx`, `src/server/routes/canned.ts` |
| Analytics | Dashboard › Analytics | `src/portal/screens/analytics.tsx`, `src/server/routes/helpdesk-reports.ts`, `src/lib/helpdesk-report-types.ts` |
| Knowledge health (issues, Accept, Dismiss, Write a draft) | Dashboard › Knowledge health | `src/portal/screens/knowledge-health.tsx`, `src/server/routes/knowledge-health.ts` (`/site-api/helpdesk/health`), `src/lib/knowledge-health-types.ts` |
| The weekly check | background job, Mondays 07:30 your time | `src/server/knowledge/tick.ts` (starts it), `src/server/knowledge/health.ts` (finds the issues) |
| Article drafts (solved tickets, Write a draft) | Knowledge health › an issue | `src/server/knowledge/drafts.ts` (the jobs), `src/server/ai/draft.ts` (what is sent, and the checks on what comes back) |
| Accept → draft article | Knowledge health › an issue › Accept | `src/server/knowledge/accept.ts`, `src/server/kb/articles.ts` (the article write path, shared with the editors) |
| Weekly check time zone | Dashboard › Assistant › Weekly check | `src/lib/time-zone.ts`, `src/server/routes/helpdesk-settings.ts` |
| Test Lab | Dashboard › Test Lab | `src/portal/screens/test-lab.tsx`, `src/server/routes/test-lab.ts` (`/site-api/helpdesk/test-lab`), `src/server/knowledge/test-lab.ts` (the runs), `src/lib/test-lab.ts` (limits, import, score) |
| AI spending for drafts and Test Lab | | `src/server/ai/spend.ts` (with `src/server/ai/usage.ts`) |
| Overview tiles (open, waiting, solved this week) | Dashboard › Overview | `src/portal/screens/overview.tsx`, counters in `src/server/helpdesk/state.ts` |
| Roles and permissions | Dashboard › Roles, Users | `src/server/permissions.ts` |
| Background jobs | the platform's scheduler | `background.json`, `src/server/background.ts` |
| Colours, spacing, type | everywhere | `src/styles/global.css` (tokens), `docs/design-system.md` |
| Site name, navigation, home page words | public pages | `src/content/site.ts` |
| Database tables | | `prisma/schema.prisma`, `prisma/migrations/` |

## Turn the assistant on

### The key: `ANTHROPIC_API_KEY`

The assistant uses Anthropic's Claude with **your own** API key. Add it as an owner secret named
exactly `ANTHROPIC_API_KEY` in your site's settings on the platform. On your own computer, put
`ANTHROPIC_API_KEY=...` in `.env` and restart `npm run dev` (calls made locally are real and
billed to that key).

The site only checks whether the key is there; it never shows it, stores it or sends it to the
browser.

**Without the key (or with the cap at 0) the assistant is off.** Visitors still get the chat
window, which says "Our assistant is resting", shows the help-center articles that match their
question, and offers "Talk to a person". The Assistant screen shows a warning until the key is
added. Hand-off, the Inbox and My support all work without the key; tickets just have no AI
summary. The weekly Knowledge health check runs without the key (it makes no AI calls), but no
drafts are written (solved tickets get none, and "Write a draft" asks for the key), and Test Lab
can't run.

### The monthly spending cap

Dashboard › Assistant › Spending: a cap in US dollars per calendar month (UTC). New sites start at
**$20**. `0` turns the assistant off. The same screen shows this month's spend and number of AI
answers.

- Every AI call (chat answers, ticket summaries, article drafts and Test Lab runs) is counted
  against the same cap before it runs. Once the month's spend reaches the cap, the assistant
  behaves as if it were off until the next month or until you raise the cap; drafts stop, and a
  Test Lab run stops with "Skipped: monthly AI limit reached".
- There are also per-minute limits, so a burst can't spend the month in an hour: per visitor and
  for the whole site for chat answers; 10 drafts a minute for the whole site (solved-ticket drafts
  and "Write a draft" together); 3 Test Lab batches a minute (30 questions).
- The cap limits what this site sends. Set a limit in your Anthropic account too.

### The models

| Model | In the settings | Price per million tokens (in / out) |
| --- | --- | --- |
| Claude Opus 5.5 | "The most careful answers." The default. | $4 / $20 |
| Claude Sonnet 5.5 | "Fast and capable, about half the cost." | $2 / $10 |
| Claude Haiku 5.5 | "The fastest and cheapest, for simple questions." | $0.10 / $0.50 |

The list and prices are in `src/lib/ai-models.ts`. Only Anthropic models are offered.

### What the assistant answers from

Only your **published articles and snippets**. For each question the site searches them, sends
the best matches (up to 6) to the model with fixed instructions, and the model answers from those
alone. Drafts and archived articles are never used. An article not reviewed for 180 days ranks a
little lower. If no article matches, there is no AI call: the chat says it couldn't find this and
offers a person. Answers can still be wrong; the chat says so under each answer.

The **Confidence needed** setting (low, medium, high) decides how sure the assistant must be;
below it, the customer is handed to a person.

## Limits, said plainly

- **The chat window works only on this site's own pages.** It can't be embedded on another
  website: every page is sent with `X-Frame-Options: DENY`, and the API answers no cross-site
  (CORS) requests.
- **No website crawling.** The assistant knows only what you write, paste or import (Markdown
  articles, a CSV of questions and answers). It never reads your other websites or files.
- **No email to customers.** Replies are not emailed. Customers see them in **My support**, with a
  count of unread replies in the dashboard menu. The only emails the site sends are account emails
  (sign-up codes, password resets), which the platform sends.
- **No email notifications to you or your team** about new tickets: the platform sends account
  emails only. Check the Inbox and the Overview tiles.
- **A hand-off resumes only in the same browser tab.** The chat and a hand-off in progress are kept
  in that tab only (`sessionStorage`), and cleared on sign-out. A new tab starts a fresh chat; a
  ticket already sent is always in My support.
- **Search is Postgres full-text search**, matching words, not meaning (no vector embeddings). A
  question in another language than your articles finds nothing; write articles in the language
  your customers use.
- **Knowledge health groups questions by their words**, like search: two questions that mean the
  same in different words are two groups, and a question asked only once in the week isn't
  reported. Drafts are written in English, and every fact the conversation didn't give is left
  as an `[Add: …]` placeholder for you to fill in.
- **Test Lab holds up to 500 questions**, and they can't be changed while a run is going; one run
  at a time.
- **Signing in is needed to talk to a person**, so a ticket always has an account to answer.
- **A solved ticket takes replies for 14 days**, then it is closed. Customers can send 30 messages
  (hand-offs and replies) an hour.

## Privacy

- **The AI provider gets as little as it needs.** It gets the fixed instructions, the matching
  help-center text and the customer's own words in this chat: never the customer's account, the name
  or email address on it, an IP address or a cookie. Whatever else a customer types (a street
  address, for example) is sent as typed, apart from the masking below. Ticket summaries get only the customer's and the assistant's chat lines,
  never internal notes or agent replies.
- **Emails, phone numbers and card numbers a customer types are masked** before they go to the AI,
  into the question log, or into a ticket's chat transcript.
- **Article drafts** send the model fixed instructions and: for a solved ticket, the customer's
  and the agents' replies in it (never internal notes) and the article the assistant cited; for
  "Write a draft", the issue's sample questions, its article and matching help-center text.
  Emails, phone numbers and card numbers are masked; the names of the ticket's customer and
  agents are replaced with `[name]` (the names themselves are never sent); links in what
  customers and visitors typed become `[link]`. Never an account, email address, ticket number
  or page path. What comes back is masked again, and keeps only links to this site or links that
  were already in the help-center text it was given.
- **Test Lab** sends the model what a customer's question would: the fixed instructions, the
  matching help-center text and the test question (masked the same way). Its questions and
  answers are kept only on the Test Lab screen, never in the question log.
- **The question log is anonymous**: the question (masked), its outcome, the best article, the
  cost, the page path and the browser's language, with no account, name, email or IP. Only people allowed to see reports read it (Analytics).
- **A deleted customer's tickets are kept, anonymised**: the link to the account is removed and
  the Inbox shows them as "Deleted customer". They no longer appear in anyone's My support.
- Staff screens never show a customer's email in the Inbox; it is in Users, for those allowed to
  see users.

## What owners usually change

| What | Where |
| --- | --- |
| Brand colour | the `--accent` tokens (`--accent`, `--accent-hover`, `--accent-soft`, `--accent-text`, `--accent-ink`) in `src/styles/global.css`, in both the light and the dark blocks. The help center, chat and dashboard follow. |
| Assistant's name, greeting, tone | Dashboard › Assistant |
| Model, confidence needed, monthly cap | Dashboard › Assistant |
| Chat button label, business hours | Dashboard › Assistant › Chat button |
| Quick replies (up to 6 buttons in the chat) | Dashboard › Assistant › Chat button |
| Human-only topics (words that always go to a person, up to 30) | Dashboard › Assistant › Hand-off |
| Help center title and intro | Dashboard › Assistant › Help center |
| Time zone of the weekly Knowledge health check (Mondays 07:30) | Dashboard › Assistant › Weekly check |
| Test questions and what each expects | Dashboard › Test Lab |
| Articles, categories, snippets | Dashboard › Knowledge base |
| Saved replies (`{{customer.firstName}}` and `{{agent.firstName}}` are filled in) | Dashboard › Saved replies |
| Who can do what | Dashboard › Roles, then give people roles in Users |
| Site name, top navigation, home page and about words | `src/content/site.ts` |

## Who can do what

| Permission | Lets them | Given to |
| --- | --- | --- |
| `site:kb:edit` | write, publish, archive and import articles, categories and snippets | Admin, Support agent |
| `site:helpdesk:inbox` | see and answer tickets, notes, assign, change status and priority, saved replies | Admin, Support agent |
| `site:helpdesk:settings` | the Assistant screen and Test Lab | Admin |
| `site:helpdesk:reports` | Analytics and Knowledge health (see issues, Dismiss, Write a draft); Accept also needs `site:kb:edit` | Admin |
| `site:helpdesk:delete` | delete a ticket and its conversation | Admin |

The **Support agent** role (Inbox and knowledge base, no settings, reports or deletes) is created
by the database migration. The owner has every permission. Anyone else who signs up is a normal
member: they can use the chat and My support only. Permissions are declared once, in
`src/server/permissions.ts`.

## Not included

- Website crawling or importing from a URL.
- Embedding the chat on other websites.
- WhatsApp, Messenger, SMS or email as channels (no inbound email).
- Voice.
- Email to customers when you reply or solve a ticket. The design is ready for it: My support
  opens a ticket's rating with a `#rate` link (`/dashboard/support/<number>#rate`), for a future
  "solved" email to point to.
- Several brands or help centers on one site.
- Payments: the help desk sells nothing (the template's checkout is there, unused).

## Sample data

`prisma/seed.sql` fills an empty help desk with **Northwind Coffee Co.**, a made-up coffee
roaster: 5 categories, articles (published, drafts and one archived), 10 snippets, the search index
for them, 15 sample questions for Analytics, 3 saved replies, and the assistant named "Bean". Also
**3 open Knowledge health issues** (two gaps with a draft ready to review: a new article on
visiting the roastery, and an added section on a leaking espresso machine for "Descaling your
espresso machine or kettle"; and one stale article, "Using a discount or gift code") and **8 Test Lab questions**, never run: 6 expect an answer (2 of them
with no expected article; "Do you sell matcha?" is a known gap, so it fails) and 2 expect a
hand-off (a refund, and asking for a real person). No users, conversations or tickets. It stops without changing anything if the help desk is already in
use, and it is safe to run twice. Never load it into your live database.

## Background jobs

Declared in `background.json`, handled in `src/server/background.ts`:

9 job lists and 4 schedules. `npm run platform -- jobs` checks that every list has a handler.

| Job (list) | When | What |
| --- | --- | --- |
| `ticket-summaries` | when a ticket is created and its summary couldn't be written at once | writes the AI summary (retried) |
| `ticket-summaries-sweep` | every 15 minutes (schedule) | summarises tickets left without a summary (a job that was never sent) |
| `helpdesk-counters` | daily, 04:00 (schedule) | recounts the Overview tiles, prunes old counters and "who's viewing" rows |
| `rate-windows-cleanup` | hourly (schedule) | deletes old rate-limit counters |
| `knowledge-health-tick` | every 30 minutes (the `knowledge-health` schedule) | starts the weekly check once a week, as soon as it is Monday 07:30 in your time zone (a missed Monday still runs later that week); marks stalled checks, drafts and Test Lab runs failed; sends article drafts for solved tickets whose job never went out (15 minutes to 48 hours after the solve); deletes weekly-check records older than 26 weeks. Not retried: the next tick comes in 30 minutes. |
| `knowledge-health` | sent by the tick, once a week | the weekly check: gaps, stale and low-rated articles. No AI calls. A big knowledge base goes on in a next job. |
| `article-drafts` | sent when a ticket is solved (and by the tick) | the AI draft from one solved ticket, filed in Knowledge health (one per ticket) |
| `health-drafts` | sent by "Write a draft" | the AI draft for one Knowledge health issue |
| `test-lab` | sent by "Run all" | asks 10 test questions (4 at a time), saves the results, then sends the next 10 until the run is done |

## For your AI

- Read `AGENTS.md` first, every session: the rules for this site and the topic docs in
  `docs/agent/` (UI, security, database, roles, background jobs…).
- Read `docs/design-system.md` before any change to a page, screen or style: the help center, chat
  and dashboard share one set of tokens and components (`src/portal/ui/`).
- The tests describe how it must behave: `tests/` (unit: hand-off, ticket rules, reports, AI prompt
  and provider, AI drafts `ai-draft`, the Knowledge health tick `knowledge-tick`, Test Lab import
  and score `test-lab-import` / `test-lab-score`, the weekly time zone `time-zone`, permissions,
  design tokens) and `tests/integration/` (the real API on Postgres: kb, helpdesk, support, inbox,
  reports, summaries, `article-drafts`, `knowledge-health-routes`, `knowledge-health-run`,
  `test-lab`). Run `npm test`, and the integration tests as in [Tests](#tests).
- Money and status changes are decided by the database in one statement (`src/server/ai/usage.ts`,
  `src/server/ai/spend.ts`, `src/server/helpdesk/state.ts`): keep it that way. New AI calls go
  through `spend.ts`, so they count against the same monthly cap.
- Nothing AI-written is ever published by the code: Knowledge health's Accept writes a **draft**
  article only (`src/server/knowledge/accept.ts`). Keep it that way.
- Never edit the template's own files (see [Building on it](#building-on-it)).

---

## Quick start

With [Node.js 22.12+](#requirements) and Docker running:

```bash
git clone <this repository's address> my-site
cd my-site
npm install
docker compose up -d --wait db      # a local Postgres (docker-compose.yml)
npm run setup                       # .env with a new JWT_SECRET, database check, tables
npm run db:seed                     # optional: the Northwind Coffee sample help desk
npm run dev                         # http://localhost:4321
```

Then [create your admin account](#create-your-admin-account): sign up at
http://localhost:4321/account/register/, type the code printed by `npm run dev`, and run
`npm run dev-admin -- you@example.com`. To try the assistant, add `ANTHROPIC_API_KEY` to `.env`
([Turn the assistant on](#turn-the-assistant-on)).

## Requirements

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 22.12 or later (`.nvmrc` says 22: `nvm use`) | `node -v` |
| npm | the one that comes with Node.js | `npm -v` |
| Docker | any recent Docker Desktop or Engine with `docker compose` | `docker compose version` |
| git | any | `git --version` |

No Docker? Any Postgres 15 or later on your computer works: put its address in `DATABASE_URL`
([Settings](#settings-env)).

## Setting up, step by step

`npm run setup` does [Settings](#settings-env) and [The database](#the-database) for you (not the
sample data); this is what it does, and how to do it by hand.

### Get the code

Clone the template repository, so later releases can be merged into your work
([Staying up to date](#staying-up-to-date)):

```bash
git clone <the template repository's address> my-site
cd my-site
git remote rename origin upstream             # the template: releases come from here
git remote add origin <your own repository's address>
git push -u origin main
```

Don't use a "Use this template" button or copy the files: that makes a copy with no shared
history, and `git merge` can no longer tell your changes from the template's. Already did? See
[Started from a copy](#started-from-a-copy).

### Install

```bash
npm install
```

### Settings (.env)

`npm run setup` makes `.env` from `.env.example`, generates a `JWT_SECRET` and points
`DATABASE_URL` at the local database. It never overwrites a value you set. By hand:
`cp .env.example .env` and fill in the two required values. `.env` stays on your computer (git
ignores it): never commit it. Restart `npm run dev` after changing it.

| Variable | On your computer | What it is |
| --- | --- | --- |
| `DATABASE_URL` | **required** | the Postgres connection string. Local: `postgresql://postgres:dev@localhost:5432/site`. |
| `JWT_SECRET` | **required**, 32+ random characters | signs sign-in tokens and keys the rate limits. Make one: `openssl rand -base64 48`. |
| `ANTHROPIC_API_KEY` | optional | your Anthropic API key; without it the assistant is off ([Turn the assistant on](#turn-the-assistant-on)). On a hosted site it is an owner secret instead. |
| `SITE_KEY` | **leave empty** | the secret the platform gives hosted sites to send account emails. Empty turns on [local development mode](#local-development-mode). |
| `SITE_URL` | leave empty | the site's address on the platform, where it answers `/api/*`. |
| `SITE_PREVIEW` | leave empty | `1` only in the platform editor's Preview. |
| `SITE_OWNER_ID` | leave empty | the platform's opaque id for the account's owner. |
| `DB_PORT` | optional | the port `docker-compose.yml` publishes when 5432 is taken ([Troubleshooting](#troubleshooting)). The site never reads it. |

### The database

`docker-compose.yml` runs Postgres 16 with a database named `site` (user `postgres`, password `dev`),
kept in a Docker volume between restarts:

```bash
docker compose up -d --wait db    # start (and wait until it is ready)
docker compose stop db            # stop, keeping the data
docker compose down -v            # delete it, data included: start from empty
```

Create the tables, and run it again after every new migration (yours or a template release's):

```bash
npm run db:migrate                # prisma migrate deploy
npm run db:seed                   # optional: the sample data in prisma/seed.sql
```

### Run it

```bash
npm run dev                       # http://localhost:4321
```

If `npm run dev` returns to the prompt with "Dev server running at…", it runs in the background:
`npx astro dev logs` shows its output, `npx astro dev stop` stops it.

## Local development mode

There is no `SITE_KEY` on your computer, so nothing can be emailed. While `npm run dev` runs with
an empty `SITE_KEY`, the site is in **local development mode**: every account email (sign-up and
sign-in codes, reset and confirmation links) is printed where `npm run dev` runs (or in
`npx astro dev logs`), under "LOCAL DEVELOPMENT ONLY", instead of being sent:

```
────────── LOCAL DEVELOPMENT ONLY: this email was not sent ──────────
  sign_up_code → you@example.com
  code: 123456
  link: http://localhost:4321/account/verify/?signup=…
```

It is off as soon as `SITE_KEY` or `SITE_PREVIEW` is set, with `NODE_ENV=production`, and in every
`npm run build` (the check is compiled out), so it is never on a hosted site.

## Create your admin account

On a hosted site the admin is the account's owner, who opens it with "View as admin" in the
dashboard. On your computer nobody can press that, so you make a local admin:

1. Open http://localhost:4321/account/register/ and sign up with any address (`you@example.com`)
   and a password of 10 or more characters.
2. Type the 6-digit code printed by `npm run dev` ([Local development mode](#local-development-mode)).
3. In another terminal, in the project folder:
   ```bash
   npm run dev-admin -- you@example.com
   ```
4. Open (or reload) http://localhost:4321/dashboard/: the knowledge base, Inbox, Assistant,
   Test Lab, Analytics, Knowledge health, Users, Roles and Activity are there.

To try the customer side, sign up a second account in a private window: it gets the chat hand-off
and My support only.

`dev-admin` changes your LOCAL database only. It refuses when `SITE_KEY` or `SITE_PREVIEW` is set or
`NODE_ENV=production`, and when `DATABASE_URL` isn't on this computer: its host must be
`localhost`, `*.localhost`, `127.x.x.x`, `::1` or a docker compose service name (one word, no dots).
It never makes an owner, so the few things only the owner can do (editing roles) can't be tried
locally.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | checks Node.js and packages, makes `.env` (new `JWT_SECRET`), checks the database, creates the tables |
| `npm run dev` | the dev server, http://localhost:4321 |
| `npm run build` | the production build into `dist/` (what the platform builds) |
| `npm test` | unit tests; integration tests too with `TEST_DATABASE_URL` ([Tests](#tests)) |
| `npm run check` | `npm test`, then `npm run build`: run it before you push |
| `npm run db:migrate` | applies new migrations (`prisma migrate deploy`) |
| `npm run db:seed` | loads `prisma/seed.sql` (Northwind Coffee) |
| `npm run dev-admin -- <email>` | a local admin ([Create your admin account](#create-your-admin-account)) |
| `npm run studio` | Prisma Studio on http://localhost:5555, to browse the database |
| `npm run preview` | serves the last `npm run build` |
| `npm run platform -- jobs` | checks `background.json` and its handlers |
| `npm run platform -- check` | the template's own files untouched, and is a newer release out ([Staying up to date](#staying-up-to-date)) |
| `npm run platform -- docs --site <a hosted site's address>` | the platform's latest rules for AI agents, into `.platform/docs/` |

## Project structure

```
AGENTS.md                rules for AI agents (CLAUDE.md, GEMINI.md import it)
docs/agent/              the rules by topic: auth, roles, security, performance, database, UI, SEO…
docs/design-system.md    the help desk's tokens, classes and components
background.json          scheduled and queued jobs
prisma/                  schema.prisma, migrations/, seed.sql (Northwind Coffee)
tests/                   unit tests; tests/integration/ = the Site API on a real Postgres
public/                  files served as they are (_headers: security headers)
src/
  content/site.ts        navigation, home sections, about copy, the site's name and address
  pages/help/            the public help center
  pages/                 also: index, about, blog/, account/, dashboard/, site-api/, sitemap, RSS
  layouts/Base.astro     public page frame; mounts the chat window
  portal/                the dashboard (React): routes.tsx, screens/, ui/ (the UI kit)
  server/routes/         the API: kb, kb-manage, helpdesk, helpdesk-settings, support, inbox,
                         canned, helpdesk-reports, knowledge-health, test-lab
  server/ai/             the assistant: retrieve, prompt, provider, answer, usage (the cap),
                         draft (article drafts: input, masking, checks), spend (the cap for
                         drafts and Test Lab)
  server/knowledge/      Knowledge health and Test Lab jobs: tick (weekly start, clean-up),
                         health (the weekly check), drafts, accept, test-lab (the runs)
  server/helpdesk/       ticket status changes and counters (state.ts), AI summaries (summary.ts)
  server/kb/             search, chunks, Markdown rendering, cached settings, articles (the
                         article write path)
  server/background.ts   one handler per job list in background.json
  server/permissions.ts  every permission
  lib/                   shared types and browser code (the widget, hand-off, models, import,
                         knowledge-health-types, test-lab, time-zone)
  styles/                global.css (tokens), app.css (dashboard), inbox.css, support.css
  platform/              the template's managed core (auth, guards, platform calls): never edit
```

## Building on it

- **Your code**: `src/server/` (routes), `src/pages/` (pages), `src/portal/` (dashboard screens),
  `src/content/` (words), `src/lib/`, `src/styles/`, `prisma/`. `AGENTS.md` and `docs/agent/` have
  the rules for each: read them, or have your AI read them, before every change.
- **Never edit the template's own files**: `src/platform/`, `docs/agent/`, `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/platform.mjs` and `scripts/managed-files.json`.
  Releases replace them (that is how security fixes arrive). Each is compared byte for byte with the
  release `template.json` names: `npm run platform -- check` lists any that changed. Put one back
  with `git checkout v<your version> -- <file>`. Extend them from your own code. `.gitattributes`
  keeps every text file LF, so a Windows checkout doesn't change them.
- **Changing the database**: a new migration for every change, never an edit to an applied one.
  ```bash
  npx prisma migrate dev --create-only --name add_ticket_tags   # 1. write it
  # 2. wrap prisma/migrations/<…>/migration.sql in BEGIN; … COMMIT;
  npx prisma migrate dev                                         # 3. apply it
  npx prisma generate                                            # 4. the client gets the new model
  ```
  Change tables in steps (add, fill, switch, drop later): `docs/agent/database.md`.
- **Sample data, `prisma/seed.sql`**: made-up rows, never for a live database. Keep it wrapped in
  `BEGIN;` … `COMMIT;`, starting with the block that stops when real data is there, safe to run
  twice, with no users or passwords.
- **Before you push**: `npm run check` and `npm run platform -- check`.

## Tests

```bash
npm test                          # unit tests
```

Integration tests run the real Site API on a real Postgres and **empty that database first**: give
them a database of their own, never the one you work in.

```bash
docker compose exec db createdb -U postgres site_test
DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npm test
```

## Staying up to date

Template releases are tagged `vX.Y.Z` in the template repository (`upstream`). `CHANGELOG.md` says
what each changed and whether it is required. With your work committed:

```bash
git fetch upstream --tags
git describe --tags --abbrev=0 upstream/main   # the newest release
git merge "$(git describe --tags --abbrev=0 upstream/main)"
npm install
npm run db:migrate
npm run check
```

Then follow the new `docs/agent/upgrade.md` for anything that release asks of files you changed.

**Conflicts** (git lists them; search for `<<<<<<<`):
- `package-lock.json`: `git checkout --theirs package-lock.json`, then `npm install` (it rebuilds the
  lock for the merged `package.json`), then commit.
- The template's own files (`src/platform/`, `docs/agent/`, `scripts/`, `template.json`,
  `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`): take the template's
  (`git checkout --theirs <file>`). Never keep changes of your own in them: describe your project in `README.md` instead.
- Your files (the help desk's pages, screens, routes, `src/content/site.ts`, styles): keep your
  side, and bring over what the template changed.
- `git merge --abort` puts everything back as it was.

### Started from a copy

No shared history with the template: connect it once, then merge releases as above.

```bash
git remote add upstream <the template repository's address>
git fetch upstream --tags
git merge v<the version in your template.json> --allow-unrelated-histories   # once
git merge "$(git describe --tags --abbrev=0 upstream/main)"                # then the newest release
```

The first merge lists every file that differs from that release: keep your side of your own files
(`git checkout --ours <file>`) and the template's side of its own files
(`git checkout --theirs <file>`), then commit.

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| the chat says "Our assistant is resting" | no `ANTHROPIC_API_KEY`, the cap is 0, or this month's cap is used up | add the key (owner secret, or `.env` and restart locally); check Dashboard › Assistant › Spending |
| the assistant never answers, always "couldn't find this" | nothing published matches the words of the question | publish articles or snippets in the customers' words; on a fresh database, `npm run db:seed` |
| no Inbox, Assistant, Test Lab, Analytics or Knowledge health in the dashboard | your account lacks the permission | an admin gives you the role (Support agent or Admin) in Users |
| `npm install` warns `EBADENGINE`, or `npm run setup` says Node.js is too old | Node.js below 22.12 | `nvm install 22`, then `nvm use 22` (or install 22.12+), then `npm install` again |
| `docker compose up` says `Bind for 0.0.0.0:5432 failed: port is already allocated` | another Postgres already uses port 5432 | put `DB_PORT=5433` in `.env` (and `:5433` in `DATABASE_URL` if it is already set), then `docker compose up -d --wait db` and `npm run setup` |
| `npm run setup` says `no database answers at localhost:5432` (or `ECONNREFUSED`) | the database isn't running, or Docker isn't | start Docker, then `docker compose up -d --wait db`, then `npm run setup` |
| sign-up answers 503 `auth_not_configured`: "Sign-in is not set up on this site yet" | `JWT_SECRET` is missing or shorter than 32 characters | `npm run setup` (or `openssl rand -base64 48` into `.env`), then restart `npm run dev` |
| pages or sign-in answer 503 `site_database_disabled` | `DATABASE_URL` is empty | `npm run setup`, then restart `npm run dev` |
| sign-up answers 500, and the dev server shows `relation "…" does not exist` | the tables aren't created (migrations pending) | `npm run db:migrate` |
| `npm run db:seed` says the help desk is already in use | the database has your own articles, tickets or questions | that's on purpose: sample data never mixes with real data. Use an empty database. |
| no code appears after signing up | `SITE_KEY` is set (codes are then emailed by the platform), or the dev server runs in the background | empty `SITE_KEY` in `.env` and restart; or read `npx astro dev logs` |
| no new code when you sign up again with the same address | account emails to one address are limited | use the code printed the first time, wait a few minutes, or sign up with another address |
| `dev-admin` says `no account for …` | that address hasn't finished signing up in this database | sign up and type the code first |
| `dev-admin` says `refused (local development only)` | `SITE_KEY`, `SITE_PREVIEW` or `NODE_ENV=production` is set, or `DATABASE_URL` isn't on this computer | empty them in `.env` (it only ever changes a local database) |
| `npm run dev` says port 4321 is in use, or opens another port | another dev server is running | use the address it prints, or stop the other one (`npx astro dev stop`) |
| http://localhost:4321 shows a different project, or sign-up says "This form has expired" | another app already listens on 127.0.0.1:4321 | stop the other app, or run this one on a free port: `npx astro dev stop && npx astro dev --port 4322` |
| the dashboard shows nothing for admins after `dev-admin` | the page was open before | reload `/dashboard/` |

## FAQ

**Can I be the owner on my computer?** No. The owner is only ever the account's owner on the
platform, through "View as admin". Locally you are an admin, which covers everything but editing
roles.

**Do I need a Site Key?** No. Without one the site runs in local development mode. Never copy a
hosted site's Site Key to your computer.

**Can I use another AI provider?** Not yet: only Anthropic models are listed
(`src/lib/ai-models.ts`).

**Can I use another database?** Postgres only (any Postgres 15+).

**Where do emails go on my computer?** Nowhere: account emails are printed where `npm run dev`
runs. The help desk itself sends no email.

**How do I start over?** `docker compose down -v`, `docker compose up -d --wait db`,
`npm run setup`.

**Can I deploy it somewhere else?** It is built to run on the platform it came from (one Worker,
its database, its emails, its background jobs); there is no other deploy config.

---

## On the platform

### Put it live

**Enable the Site Database first.** This project ships migrations; a version with migrations is
refused until the site has a database. Then add the `ANTHROPIC_API_KEY` owner secret and
**Publish**. Only your account's owner can open the admin, with **View as admin** in the
dashboard. Anyone who signs up is a normal user, whatever email they use.

The platform installs with `npm ci`, runs `npm run build` (`prisma generate && astro build`),
applies new migrations to your live database, then deploys. If a migration fails, the previous
version keeps serving.

### Accounts

- The **owner** is your account's owner, who opens the admin with **View as admin** in the
  dashboard or the editor. There's no owner sign-up, password or owner list. Owners and admins
  manage users at `/dashboard/users` and roles at `/dashboard/roles`.
- Sign-up codes and password-reset emails are sent by the platform on your site's behalf.
- Change how sign-up works in `src/server/auth-settings.ts`.

### Write a blog post

Add a Markdown file to `src/content/blog/` (`my-post.md` → `/blog/my-post/`) with a `title`,
`description` and `publishedAt` at the top (see `how-to-add-a-post.md` there), then Publish. Help
articles are written in the dashboard instead.

### What this site controls

| Address | Served by |
| --- | --- |
| `/`, `/about/`, `/blog/` | this site |
| `/help/…` | this site (the help center) |
| `/sitemap.xml`, `/robots.txt`, `/rss.xml` | this site (search engines, feed readers) |
| `/account/login`, `/account/register`, `/account/forgot`, … | this site (sign-in) |
| `/dashboard/…` | this site (the dashboard, My support, the Inbox) |
| `/site-api/…` | this site (your API) |
| `/api/…` | the platform |
