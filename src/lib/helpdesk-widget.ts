/**
 * The help-desk chat widget on public pages (BROWSER-ONLY). Base.astro renders an
 * `<aside data-hd-root transition:persist>` mount on public pages (not `/account`,
 * `/dashboard`, `/checkout`) and imports this module, when the browser is idle, only
 * when the mount is there.
 *
 * - `GET /site-api/helpdesk/widget` (WidgetConfig): fails → nothing is rendered.
 * - `POST /site-api/helpdesk/ask` (AskInput → AskResult), `POST …/ask/:logId/helpful`.
 * - "Talk to a person": signed out → sign in / create an account, back to this page;
 *   signed in → a confirm step, then `POST /site-api/helpdesk/conversations`
 *   (CreateConversationInput → CreateConversationResult) with the hand-off's key.
 * - What it keeps in `sessionStorage` (transcript, hand-off, sent request) is in
 *   `./helpdesk-handoff.ts`; Base.astro clears it on sign-out (`./helpdesk-storage.ts`). A question whose
 *   request failed is not saved.
 *
 * DOM is built with createElement + textContent only (never innerHTML); no inline
 * styles but the composer's height (CSSOM, allowed by the CSP). The mount persists
 * across ClientRouter navigations, so one panel stays open from page to page.
 */
import {siteFetch} from '../platform/browser';
import {signedIn} from './account';
import {
  accountUrl,
  beginHandoff,
  forgetHandoff,
  HANDOFF_LIMITS,
  handoffBody,
  handoffOutcome,
  handoffSent,
  pendingHandoff,
  restoreTranscript,
  safeCitations,
  saveTranscript,
  sentTicket,
  ticketNumberOf,
  type Handoff,
  type Line,
  type StorageLike,
} from './helpdesk-handoff';
import {ASK_LIMITS, LOG_ID_RE, type AskCitation, type AskResult, type AskRole, type WidgetConfig} from './helpdesk-types';

/** This tab's storage, or null when the browser blocks it. */
function tabStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const KEEP = 50;
/** Full screen (and so modal) at tablet width and below; a 400px side sheet above. */
const FULL = '(max-width: 1024px)';
const API = '/site-api/helpdesk';
const NEAR_LIMIT = ASK_LIMITS.questionMax - 50;
const T = {
  resting: 'Our assistant is resting. Here’s what we found in the help center:',
  restingEmpty: 'Our assistant is resting. Talk to a person and we’ll help.',
  restingIntro: 'Our assistant is resting right now. Ask anyway to see what our help center has, or talk to a person.',
  found: 'Here’s what we found in the help center:',
  noSource: 'I couldn’t find this in our help center.',
  handoff: 'A person on our team can help with this.',
  note: 'Answers come from our help center and can be wrong.',
  person: 'Talk to a person',
  looking: 'Looking for an answer…',
  failed: 'We couldn’t reach the assistant. Check your connection and try again.',
  short: `Type a question of at least ${ASK_LIMITS.questionMin} characters.`,
  noteNeeded: 'Tell us what you need help with.',
  noteLong: `Keep your message under ${HANDOFF_LIMITS.note.toLocaleString('en-US')} characters.`,
  sendFailed: 'We couldn’t send this. Check your connection and try again.',
  unverified: 'Confirm your email address first, then try again.',
};
/** The hand-off note mirrors the server: up to TICKET_LIMITS.note, required only with no customer line. */
const NOTE_MAX = HANDOFF_LIMITS.note;
/** The note's counter shows from 80% of the limit (as the kit's Composer). */
const NOTE_COUNT_FROM = Math.floor(NOTE_MAX * 0.8);
const chars = (n: number) => `${n} ${n === 1 ? 'character' : 'characters'}`;

let config: WidgetConfig | null = null;
let loading: Promise<WidgetConfig | null> | null = null;

function loadConfig(): Promise<WidgetConfig | null> {
  if (config) return Promise.resolve(config);
  loading ??= siteFetch(`${API}/widget`, {headers: {accept: 'application/json'}})
    .then(res => (res.ok ? (res.json() as Promise<WidgetConfig>) : null))
    .then(data => {
      if (data && typeof data.name === 'string' && typeof data.launcherLabel === 'string') config = data;
      return config;
    })
    .catch(() => null)
    .finally(() => (loading = null));
  return loading;
}

/** The last 10 messages, at most 4,000 characters in all, newest kept (text only). */
function historyOf(lines: Line[]): {role: AskRole; text: string}[] {
  const out: {role: AskRole; text: string}[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < ASK_LIMITS.historyCount; i--) {
    const {role, text} = lines[i];
    if (total + text.length > ASK_LIMITS.historyChars) break;
    total += text.length;
    out.unshift({role, text});
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, className = 'button button-secondary'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  return b;
}

const SVG = 'http://www.w3.org/2000/svg';
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'hd-icon');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const CHAT_ICON = ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'];
const CLOSE_ICON = ['M18 6 6 18', 'm6 6 12 12'];

function setPending(b: HTMLButtonElement, label: string | null): void {
  if (label) {
    b.dataset.label = b.textContent ?? '';
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    const spin = el('span', 'spinner');
    spin.setAttribute('aria-hidden', 'true');
    b.replaceChildren(spin, document.createTextNode(label));
  } else {
    b.disabled = false;
    b.removeAttribute('aria-busy');
    b.textContent = b.dataset.label ?? '';
  }
}

/** Builds the launcher (and, on first open, the panel) inside `root`. Idempotent. */
export async function mountHelpdeskWidget(root: HTMLElement): Promise<void> {
  if (root.dataset.hdBound) return;
  root.dataset.hdBound = '1';
  const cfg = await loadConfig();
  if (!cfg || !root.isConnected) {
    delete root.dataset.hdBound;
    return;
  }

  const panelId = 'hd-panel';
  const titleId = 'hd-title';
  const launcher = button('', 'hd-launcher button');
  launcher.append(icon(CHAT_ICON), el('span', '', cfg.launcherLabel || 'Help'));
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-haspopup', 'dialog');
  root.append(launcher);

  const storage = tabStorage();
  let panel: HTMLElement | null = null;
  let log: HTMLElement;
  let live: HTMLElement;
  let input: HTMLTextAreaElement;
  let send: HTMLButtonElement;
  let error: HTMLElement;
  let count: HTMLElement;
  let quick: HTMLElement | null = null;
  let busy = false;
  /** The hand-off under way (its key is reused on every retry) and whether it is being sent. */
  let handoff: Handoff | null = pendingHandoff(storage);
  let sending = false;
  let inerted: Element[] = [];
  const full = window.matchMedia(FULL);
  const transcript = restoreTranscript(storage);
  // Document and media listeners: one set per root, dropped when the root leaves the page.
  const ac = new AbortController();
  const {signal} = ac;

  const remember = (line: Line) => {
    transcript.push(line);
    if (transcript.length > KEEP) transcript.splice(0, transcript.length - KEEP);
    saveTranscript(storage, transcript);
  };

  const scroll = () => (log.scrollTop = log.scrollHeight);

  /** The one place screen readers hear the chat: short text only (the log itself is silent). */
  const announce = (text: string) => {
    live.textContent = '';
    if (text) requestAnimationFrame(() => (live.textContent = text));
  };

  /** Chips (quick replies, follow-ups) send their text as the next question. */
  const chips = (labels: string[], className: string): HTMLElement => {
    const wrap = el('div', `hd-chips ${className}`);
    for (const label of labels.slice(0, 6)) {
      const chip = button(label, 'hd-chip');
      chip.addEventListener('click', () => void ask(label));
      wrap.append(chip);
    }
    return wrap;
  };

  const customer = (text: string): HTMLElement => {
    const msg = el('div', 'hd-msg hd-msg-customer');
    msg.append(el('p', 'hd-bubble', text));
    log.append(msg);
    return msg;
  };

  const sources = (list: AskCitation[]): HTMLElement | null => {
    if (!list.length) return null;
    const box = el('div', 'hd-sources');
    box.append(el('p', 'hd-sources-title', 'Sources'));
    const ol = el('ol');
    for (const c of list) {
      const li = el('li');
      const a = el('a', '', c.title || c.url);
      a.href = c.url;
      li.append(a);
      ol.append(li);
    }
    box.append(ol);
    return box;
  };

  /** Inline buttons sit only on the latest reply; the header's stays. */
  const personButton = (primary: boolean, inline = true) => {
    const b = button(T.person, `button${primary ? '' : ' button-secondary'}${inline ? ' hd-inline-person' : ' hd-head-person'}`);
    b.addEventListener('click', () => void talkToPerson(b));
    return b;
  };

  /** The hand-off box: one per panel, re-used while it is the last thing in the log. */
  let personBox: HTMLElement | null = null;
  const box = (): HTMLElement => {
    if (!personBox || log.lastElementChild !== personBox) {
      personBox?.remove();
      personBox = el('div', 'hd-msg hd-msg-ai hd-person');
      log.append(personBox);
    }
    return personBox;
  };
  const hours = (): HTMLElement[] => (cfg.businessHours ? [el('p', 'hd-muted', `Our team is around ${cfg.businessHours}.`)] : []);
  /** A line that takes focus (tabIndex -1) when the box changes. */
  const lead = (text: string, className = 'hd-person-title'): HTMLElement => {
    const p = el('p', className, text);
    p.tabIndex = -1;
    return p;
  };
  /** The box is open: the reply's inline "Talk to a person" would only repeat it (the header's stays). */
  const show = (b: HTMLElement, ...nodes: Node[]) => {
    b.replaceChildren(...nodes);
    log.querySelectorAll('.hd-inline-person').forEach(n => n.remove());
    scroll();
  };
  const actions = (...nodes: HTMLElement[]) => {
    const row = el('div', 'hd-person-actions');
    row.append(...nodes);
    return row;
  };
  const link = (text: string, href: string, className = 'button'): HTMLAnchorElement => {
    const a = el('a', className, text);
    a.href = href;
    return a;
  };
  const here = () => location.pathname + location.search;

  /** "Talk to a person": already sent, signed out (sign in) or signed in (confirm). */
  async function talkToPerson(from?: HTMLButtonElement) {
    if (sending) return;
    const sent = sentTicket(storage);
    if (sent) return showSent(sent);
    if (from) setPending(from, 'One moment…');
    const yes = await signedIn();
    if (from) setPending(from, null);
    if (yes) confirmStep();
    else signInStep();
  }

  /** Step 2: sign in, or create an account, and come back to this page. */
  function signInStep(ended = false) {
    const b = box();
    const signIn = link('Sign in to continue', accountUrl('login', here()));
    const register = link('Create an account', accountUrl('register', here()), 'button button-secondary');
    // The flag (with the hand-off's key) is written only when they go, not on show.
    for (const a of [signIn, register]) a.addEventListener('click', () => (handoff = beginHandoff(storage, 'signin', Date.now(), false, handoff)));
    const title = lead(T.person);
    const endedNote = el('p', 'hd-error', 'Your sign-in ended. Sign in again to send this to our team.');
    endedNote.setAttribute('role', 'alert');
    show(
      b,
      title,
      ...(ended ? [endedNote] : []),
      el('p', '', 'Sign in so our team can reply to you. We’ll keep this conversation and send it with your request.'),
      ...hours(),
      actions(signIn, register)
    );
    title.focus();
  }

  /**
   * Step 4: signed in. A note (optional, up to the server's 4,000 characters; required
   * only when the chat has no question from them), then send.
   */
  function confirmStep(fresh = false) {
    handoff = beginHandoff(storage, 'confirm', Date.now(), fresh, handoff);
    const b = box();
    const n = transcript.length;
    const asked = transcript.some(l => l.role === 'customer');
    const field = el('div', 'field');
    const label = el('label', '', asked ? 'Anything else our team should know?' : 'What do you need help with?');
    label.htmlFor = 'hd-handoff-note';
    const note = el('textarea');
    note.id = 'hd-handoff-note';
    note.rows = 3;
    note.placeholder = asked ? 'e.g. My order number is 4471.' : 'e.g. My grinder makes a loud noise since yesterday.';
    const hint = el('p', 'field-hint', asked ? 'Optional.' : 'Required.');
    hint.id = 'hd-handoff-hint';
    const count = el('p', 'field-hint');
    count.id = 'hd-handoff-count';
    count.hidden = true;
    const err = el('p', 'field-error');
    err.id = 'hd-handoff-error';
    err.setAttribute('role', 'alert');
    err.hidden = true;
    note.setAttribute('aria-describedby', 'hd-handoff-hint hd-handoff-count hd-handoff-error');
    if (!asked) note.required = true;
    // Kit order: label, field, hint (hidden while there is an error), counter, error.
    field.append(label, note, hint, count, err);
    const form = el('form');
    form.noValidate = true;
    const go = button('Send to our team', 'button');
    go.type = 'submit';
    const keep = button('Keep chatting');
    form.append(field, actions(go, keep));
    const status = el('p', 'hd-error');
    status.setAttribute('role', 'alert');
    status.hidden = true;
    const title = lead(T.person);
    show(
      b,
      title,
      el(
        'p',
        '',
        n && asked
          ? `We’ll send this conversation (${n} ${n === 1 ? 'message' : 'messages'}) to our team with a short summary. They’ll reply in My support, on your dashboard.`
          : 'Tell us what you need, and our team will reply in My support, on your dashboard.'
      ),
      form,
      status,
      ...hours()
    );

    const fieldError = (text: string) => {
      err.textContent = text;
      err.hidden = !text;
      hint.hidden = !!text;
      if (text) note.setAttribute('aria-invalid', 'true');
      else note.removeAttribute('aria-invalid');
    };
    /** What is wrong with the note, as the server would say it, or ''. */
    const problem = () => {
      const text = note.value.trim();
      if (text.length > NOTE_MAX) return T.noteLong;
      if (!asked && !text) return T.noteNeeded;
      return '';
    };
    const showNoteCount = () => {
      const len = note.value.trim().length;
      count.hidden = len < NOTE_COUNT_FROM;
      count.textContent = len > NOTE_MAX ? `${chars(len - NOTE_MAX)} too long.` : `${chars(NOTE_MAX - len)} left.`;
    };
    let checked = false;
    note.addEventListener('blur', () => {
      if (note.value.trim()) checked = true;
      if (checked) fieldError(problem());
    });
    note.addEventListener('input', () => {
      showNoteCount();
      // Over the limit shows at once; "required" waits for a blur or a submit.
      if (checked || note.value.trim().length > NOTE_MAX) fieldError(problem());
    });
    keep.addEventListener('click', () => {
      b.remove();
      personBox = null;
      input.focus();
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (sending) return;
      checked = true;
      const wrong = problem();
      if (wrong) {
        fieldError(wrong);
        note.focus();
        return;
      }
      fieldError('');
      status.hidden = true;
      status.replaceChildren();
      void create(note, go, keep, status, fieldError);
    });
    title.focus();
  }

  /** Step 5: POST the conversation with the hand-off's key (the same key on every retry). */
  async function create(
    note: HTMLTextAreaElement,
    go: HTMLButtonElement,
    keep: HTMLButtonElement,
    status: HTMLElement,
    fieldError: (text: string) => void
  ) {
    handoff ??= beginHandoff(storage, 'confirm');
    const key = handoff.key;
    sending = true;
    setPending(go, 'Sending…');
    note.readOnly = true;
    keep.disabled = true;
    // The composer's Send is only disabled: the hand-off's own button shows the progress.
    setBusy(true, false);
    const typing = dots();
    log.append(typing);
    scroll();
    announce('Sending your conversation to our team…');
    let code: number | null = null;
    type Answer = {error?: unknown; message?: unknown; fields?: Record<string, string>; ticket?: unknown} | null;
    let data = null as Answer;
    try {
      const res = await siteFetch(`${API}/conversations`, {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/json', 'idempotency-key': key},
        body: JSON.stringify(handoffBody(key, transcript, note.value, location.pathname)),
      });
      code = res.status;
      data = (await res.json().catch(() => null)) as Answer;
    } catch {
      // Network: retry with the same key.
    }
    typing.remove();
    // The outcome speaks for itself (focus on the title, or the alert): no stale "Sending…".
    announce('');
    sending = false;
    setBusy(false);
    const outcome = handoffOutcome(code);
    const number = ticketNumberOf(data);
    if (outcome === 'sent' && number) {
      handoffSent(storage, number);
      handoff = null;
      transcript.length = 0;
      showSent(number, true);
      return;
    }
    if (outcome === 'signin') {
      signInStep(true);
      return;
    }
    if (outcome === 'stop') {
      forgetHandoff(storage);
      handoff = null;
    }
    setPending(go, null);
    note.readOnly = false;
    keep.disabled = false;
    if (code === 422 && data?.fields) {
      fieldError(data.fields.note ?? Object.values(data.fields)[0] ?? T.sendFailed);
      announce('');
      note.focus();
      return;
    }
    if (code === 403 && data?.error === 'email_unverified') {
      // Not confirmed yet: the account page shows the address and how to confirm it.
      status.replaceChildren(document.createTextNode(`${T.unverified} `), link('Go to your account', '/dashboard/account', ''));
    } else {
      // 429 (the hourly or the per-minute window) and other 4xx carry the server's own words.
      status.textContent =
        code !== null && code < 500 && typeof data?.message === 'string' && data.message ? data.message : T.sendFailed;
    }
    status.hidden = false;
    go.focus();
  }

  /** Step 6 (and later clicks in this tab): the request's number and a way to it. */
  function showSent(number: number, now = false) {
    const b = box();
    const view = link('View your request', `/dashboard/support/${number}`);
    if (now) {
      // Focus on the title says it (no announcement on top).
      const title = lead(`Thanks, we’ve got it. Your request number is #${number}.`);
      show(b, title, el('p', '', 'You’ll see our reply in My support.'), ...hours(), actions(view));
      title.focus();
      return;
    }
    const again = button('Start a new request');
    again.addEventListener('click', () => {
      forgetHandoff(storage);
      handoff = null;
      void talkToPersonFresh(again);
    });
    const title = lead('You’ve already sent a request');
    show(b, title, el('p', '', `Your request number is #${number}. Add to it there, or start a new one.`), actions(view, again));
    title.focus();
  }

  /** "Start a new request": past the sent check, a new key. */
  async function talkToPersonFresh(from: HTMLButtonElement) {
    setPending(from, 'One moment…');
    const yes = await signedIn();
    setPending(from, null);
    if (yes) confirmStep(true);
    else signInStep();
  }

  const helpful = (logId: string): HTMLElement => {
    const box = el('div', 'hd-helpful');
    const label = el('span', 'hd-muted', 'Was this helpful?');
    const yes = button('Yes', 'button button-secondary hd-tap');
    const no = button('No', 'button button-secondary hd-tap');
    // Not a live region: it receives focus when the vote is saved.
    const status = el('span', 'hd-muted');
    box.append(label, yes, no, status);
    for (const b of [yes, no]) {
      b.addEventListener('click', async () => {
        const hadFocus = document.activeElement === b;
        const other = b === yes ? no : yes;
        other.disabled = true;
        setPending(b, 'Sending…');
        status.textContent = '';
        let failure = T.failed;
        try {
          const res = await siteFetch(`${API}/ask/${encodeURIComponent(logId)}/helpful`, {
            method: 'POST',
            headers: {'content-type': 'application/json', accept: 'application/json'},
            body: JSON.stringify({helpful: b === yes}),
          });
          if (res.ok || res.status === 404) {
            const refocus = hadFocus || document.activeElement === document.body;
            yes.remove();
            no.remove();
            label.remove();
            status.tabIndex = -1;
            status.textContent = 'Thanks for letting us know.';
            if (refocus) status.focus();
            return;
          }
          if (res.status === 429) failure = 'Too many answers right now. Try again in a minute.';
        } catch {
          // Network: the generic message.
        }
        setPending(b, null);
        other.disabled = false;
        status.textContent = failure;
        if (hadFocus || document.activeElement === document.body) b.focus();
        announce(failure);
      });
    }
    return box;
  };

  /** A restored assistant line: its text and its sources, nothing to act on. */
  const pastReply = (line: Line) => {
    const msg = el('div', 'hd-msg hd-msg-ai');
    msg.append(el('p', 'hd-answer', line.text));
    const cites = sources(line.citations ?? []);
    if (cites) msg.append(cites);
    log.append(msg);
  };

  /**
   * One AI turn. `answered`: text, sources, helpful, person, note, follow-ups.
   * `handoff`: text, then ONE primary "Talk to a person". `no_source` / `off`: text
   * (+ the search results when off), then "Talk to a person".
   */
  const reply = (result: AskResult) => {
    log.querySelectorAll('.hd-inline-person, .hd-followups').forEach(n => n.remove());
    const msg = el('div', 'hd-msg hd-msg-ai');
    const status = result.status;
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    let text: string;
    let cites: AskCitation[] = [];
    if (status === 'handoff') {
      text = answer || T.handoff;
      msg.append(el('p', 'hd-answer', text), personButton(true));
    } else if (status === 'no_source') {
      text = T.noSource;
      msg.append(el('p', 'hd-answer', text), personButton(false));
    } else if (status === 'off') {
      cites = safeCitations(result.citations);
      text = cites.length ? T.resting : T.restingEmpty;
      msg.append(el('p', 'hd-answer', text));
      const box = sources(cites);
      if (box) msg.append(box);
      msg.append(personButton(false));
    } else {
      cites = safeCitations(result.citations);
      text = answer || (cites.length ? T.found : T.noSource);
      msg.append(el('p', 'hd-answer', text));
      const box = sources(cites);
      if (box) msg.append(box);
      if (typeof result.logId === 'string' && LOG_ID_RE.test(result.logId)) msg.append(helpful(result.logId));
      msg.append(personButton(false), el('p', 'hd-note', T.note));
      const follow = Array.isArray(result.followUps)
        ? result.followUps.filter(f => typeof f === 'string' && f).slice(0, 3)
        : [];
      if (follow.length) msg.append(chips(follow, 'hd-followups'));
    }
    log.append(msg);
    remember(cites.length ? {role: 'assistant', text, citations: cites} : {role: 'assistant', text});
    const n = cites.length;
    announce(n ? `${text} ${n} ${n === 1 ? 'source' : 'sources'} below.` : text);
  };

  const notice = (text: string) => {
    const msg = el('div', 'hd-msg hd-msg-ai');
    msg.append(el('p', 'hd-answer', text));
    log.append(msg);
    announce(text);
  };

  /** `pending`: Send shows "Sending…" (a question); false: only disabled (a hand-off, its own button shows it). */
  const setBusy = (on: boolean, pending = true) => {
    busy = on;
    if (on && pending) setPending(send, 'Sending…');
    else if (on) send.disabled = true;
    else if (send.hasAttribute('aria-busy')) setPending(send, null);
    else send.disabled = false;
    panel?.querySelectorAll<HTMLButtonElement>('.hd-chip, .hd-head-person, .hd-inline-person').forEach(c => (c.disabled = on));
  };

  const showError = (text: string) => {
    error.textContent = text;
    error.hidden = !text;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  /** A short note once the question is close to the 500-character limit. */
  const showCount = () => {
    const len = input.value.length;
    count.hidden = len < NEAR_LIMIT;
    count.textContent =
      len >= ASK_LIMITS.questionMax
        ? `That’s the ${ASK_LIMITS.questionMax}-character limit.`
        : `${chars(ASK_LIMITS.questionMax - len)} left.`;
  };

  /** The typing dots, hidden from screen readers (the live line says what is happening). */
  const dots = (): HTMLElement => {
    const typing = el('div', 'hd-msg hd-msg-ai hd-typing');
    typing.setAttribute('aria-hidden', 'true');
    const d = el('span', 'hd-dots');
    d.append(el('span'), el('span'), el('span'));
    typing.append(d);
    return typing;
  };

  async function ask(raw: string) {
    if (busy) return;
    // A chip or Send is about to be removed or disabled: keep focus in the composer.
    if (!input.contains(document.activeElement)) input.focus();
    const question = raw.trim();
    if (question.length < ASK_LIMITS.questionMin) {
      showError(T.short);
      return;
    }
    showError('');
    const history = historyOf(transcript);
    quick?.remove();
    quick = null;
    const bubble = customer(question);
    input.value = '';
    grow();
    showCount();
    const typing = dots();
    log.append(typing);
    scroll();
    announce(T.looking);
    setBusy(true);
    try {
      const res = await siteFetch(`${API}/ask`, {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify({question, history, page: location.pathname.slice(0, ASK_LIMITS.pagePath)}),
      });
      const data = (await res.json().catch(() => null)) as
        | (AskResult & {message?: string; fields?: Record<string, string>})
        | null;
      typing.remove();
      if (res.ok && data && typeof data.status === 'string') {
        remember({role: 'customer', text: question});
        reply(data);
      } else if (res.status === 422 && data?.fields) {
        // A field error belongs under the composer, with the question given back.
        bubble.remove();
        if (!input.value) input.value = question;
        grow();
        showCount();
        announce('');
        showError(data.fields.question ?? Object.values(data.fields)[0] ?? T.failed);
        input.focus();
      } else {
        notice(typeof data?.message === 'string' && data.message ? data.message : T.failed);
      }
    } catch {
      typing.remove();
      notice(T.failed);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  /** The composer grows from one control tall to 6 lines (max-height in CSS). */
  function grow() {
    input.style.height = 'auto';
    const cs = getComputedStyle(input);
    const edge =
      cs.boxSizing === 'border-box'
        ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
        : -(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    input.style.height = `${input.scrollHeight + edge}px`;
  }

  const build = (): HTMLElement => {
    const p = el('section', 'hd-panel');
    p.id = panelId;
    p.hidden = true;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-labelledby', titleId);

    const head = el('header', 'hd-head');
    const title = el('h2', 'hd-title', cfg.name || 'Help');
    title.id = titleId;
    const close = button('', 'hd-close button ghost');
    close.setAttribute('aria-label', 'Close chat');
    close.append(icon(CLOSE_ICON));
    close.addEventListener('click', () => toggle(false));
    head.append(title, personButton(false, false), close);

    // The log is silent (`live` below says what changed, in short): reading every
    // source link and button as it is added drowns the answer.
    log = el('div', 'hd-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'off');
    log.setAttribute('aria-label', 'Conversation');
    log.tabIndex = 0;
    live = el('p', 'visually-hidden');
    live.setAttribute('role', 'status');
    const intro = el('div', 'hd-msg hd-msg-ai');
    if (cfg.greeting) intro.append(el('p', 'hd-answer', cfg.greeting));
    if (!cfg.assistant) intro.append(el('p', 'hd-answer', T.restingIntro));
    if (intro.childElementCount) log.append(intro);
    for (const line of transcript) {
      if (line.role === 'customer') customer(line.text);
      else pastReply(line);
    }
    if (!transcript.length && cfg.quickReplies?.length) {
      quick = chips(cfg.quickReplies, 'hd-quick');
      log.append(quick);
    }

    const form = el('form', 'hd-composer');
    form.noValidate = true;
    const label = el('label', 'hd-label', 'Ask a question');
    label.htmlFor = 'hd-input';
    input = el('textarea', 'hd-input');
    input.id = 'hd-input';
    input.rows = 1;
    input.maxLength = ASK_LIMITS.questionMax;
    input.placeholder = 'e.g. How do I change my order?';
    input.setAttribute('aria-describedby', 'hd-error hd-count');
    error = el('p', 'hd-error');
    error.id = 'hd-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    count = el('p', 'hd-muted hd-count');
    count.id = 'hd-count';
    count.hidden = true;
    send = button('Send', 'button hd-send');
    send.type = 'submit';
    const row = el('div', 'hd-row');
    row.append(input, send);
    form.append(label, row, error, count);
    form.addEventListener('submit', e => {
      e.preventDefault();
      void ask(input.value);
    });
    input.addEventListener('input', () => {
      grow();
      showCount();
      if (!error.hidden && input.value.trim().length >= ASK_LIMITS.questionMin) showError('');
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void ask(input.value);
      }
    });

    p.append(head, log, live, form);
    return p;
  };

  /** Full screen: the panel is modal, so the page behind is inert and does not scroll. */
  const modal = () => {
    for (const n of inerted) n.removeAttribute('inert');
    inerted = [];
    const on = !!panel && !panel.hidden && full.matches && root.isConnected;
    document.documentElement.classList.toggle('hd-lock', on);
    if (panel) {
      if (on) panel.setAttribute('aria-modal', 'true');
      else panel.removeAttribute('aria-modal');
    }
    if (!on) return;
    for (const n of Array.from(document.body.children)) {
      if (n.contains(root) || n.hasAttribute('inert') || n instanceof HTMLScriptElement) continue;
      n.setAttribute('inert', '');
      inerted.push(n);
    }
  };
  full.addEventListener('change', modal, {signal});
  // A client navigation brings a new body (the root moves into it) or drops the root.
  document.addEventListener(
    'astro:after-swap',
    () => {
      modal();
      if (!root.isConnected) ac.abort();
    },
    {signal}
  );
  // Escape closes the panel from anywhere while it is open (not mid-IME composition).
  document.addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || e.isComposing || !panel || panel.hidden) return;
      e.preventDefault();
      toggle(false);
    },
    {signal}
  );

  function toggle(open: boolean, focusInput = true) {
    if (open && !panel) {
      panel = build();
      root.append(panel);
      launcher.setAttribute('aria-controls', panelId);
    }
    if (!panel) return;
    panel.hidden = !open;
    launcher.hidden = open;
    launcher.setAttribute('aria-expanded', String(open));
    root.classList.toggle('hd-open', open);
    modal();
    if (open) {
      grow();
      scroll();
      if (focusInput) input.focus();
    } else {
      launcher.focus();
    }
  }

  launcher.addEventListener('click', () => toggle(true));

  // Back from signing in (same tab, within 30 minutes): reopen with the transcript and
  // the confirm step. Still signed out (they gave up): keep the flag until it expires.
  // The one `/me` call happens only while that flag is there.
  if (handoff?.step === 'signin') {
    void signedIn().then(yes => {
      if (!yes || !root.isConnected || sending) return;
      toggle(true, false);
      confirmStep();
    });
  }
}
