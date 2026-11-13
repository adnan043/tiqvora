/**
 * Test Lab: limits, the question key, the JSON shapes of `/site-api/helpdesk/test-lab`
 * (src/server/routes/test-lab.ts) and the "Ready to launch" score. Browser-safe.
 */

export const TEST_LAB_LIMITS = {question: 500, cases: 500, importLines: 100, importChars: 50_000, batch: 10} as const;

/**
 * The key that makes two questions "the same" (test_cases.question_key, UNIQUE): NFC,
 * lower-case, single spaces, no trailing punctuation or spaces.
 */
export function normalizeQuestion(q: string): string {
  return q
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[?!.。？！\s]+$/u, '');
}

/**
 * Characters a question (or a search) may never hold: C0 controls, DEL, C1 controls (U+0080–U+009F)
 * and the bidi embedding/override/isolate controls (U+202A–U+202E, U+2066–U+2069). Checked after
 * `oneLine` (newlines and tabs are collapsed to spaces before this).
 */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
/** Zero-width characters (U+200B–U+200D, U+2060, U+FEFF): invisible, so stripped, never stored. */
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/gu;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const hasControlChars = (text: string) => CONTROL_CHARS_RE.test(text);

/**
 * One line as stored: lone surrogates repaired, zero-width characters stripped, whitespace
 * (newlines included) collapsed, trimmed. Never truncated. Null: not a string.
 */
export function oneLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(LONE_SURROGATE_RE, '�').replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').trim();
}

export const QUESTION_MESSAGE = `Type a question of 3 to ${TEST_LAB_LIMITS.question} characters.`;
export const QUESTION_CONTROL_MESSAGE = "The question has characters that can't be saved. Type it again.";

/**
 * A question as typed → `{question, key}` (the stored text and its `question_key`), or the words
 * saying what's wrong. The same rules on create, edit and import (server and screen).
 */
export function questionOf(value: unknown): {question: string; key: string} | string {
  const question = oneLine(value);
  if (question === null || question.length < 3 || question.length > TEST_LAB_LIMITS.question) return QUESTION_MESSAGE;
  if (hasControlChars(question)) return QUESTION_CONTROL_MESSAGE;
  // The key is never longer than the column (lower-casing can lengthen a few letters).
  const key = normalizeQuestion(question).slice(0, TEST_LAB_LIMITS.question);
  if (!key) return QUESTION_MESSAGE;
  return {question, key};
}

/** One question of a pasted list: its 1-based source line, the text as stored, its key. */
export interface ImportQuestion {
  line: number;
  question: string;
  key: string;
}

/** A refused line: its 1-based source line and a whole sentence that names it ("Line 3 is too long: …"). */
export interface ImportError {
  line: number;
  message: string;
}

export const IMPORT_EMPTY_MESSAGE = `Paste 1 to ${TEST_LAB_LIMITS.importLines} questions, one per line.`;
export const IMPORT_TOO_MANY_MESSAGE = `Paste up to ${TEST_LAB_LIMITS.importLines} questions at a time.`;
export const IMPORT_TOO_LONG_MESSAGE = `Paste up to ${TEST_LAB_LIMITS.importChars.toLocaleString('en-US')} characters.`;

/**
 * The "Import" paste, parsed the same way by the screen and by POST /cases/import. Pure.
 *
 *   parseImport(text: string): {questions: ImportQuestion[]; errors: ImportError[]}
 *
 * - Lines split on \r\n, \r or \n; `line` is the 1-based source line (blank lines count).
 * - Each line goes through `oneLine` (zero-width stripped, spaces collapsed); blank lines are skipped.
 * - A line that is too short (< 3), too long (> 500: an error, never cut), has control or bidi
 *   characters, or has no words is an error for that line. Every bad line is listed.
 * - The same question twice in the paste (same key) is kept once (the first), silently.
 * - More than 100 non-blank lines: one error on the 101st, and parsing stops there.
 * - `errors` empty and `questions` empty: nothing to import (IMPORT_EMPTY_MESSAGE).
 * The paste's own size (≤ 50,000 characters, IMPORT_TOO_LONG_MESSAGE) is checked by the caller first.
 * The server refuses the whole paste (422) if `errors` is not empty; nothing is half-imported.
 */
export function parseImport(text: string): {questions: ImportQuestion[]; errors: ImportError[]} {
  const questions: ImportQuestion[] = [];
  const errors: ImportError[] = [];
  const seen = new Set<string>();
  let lines = 0;
  const raw = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < raw.length; i++) {
    const n = i + 1;
    const line = oneLine(raw[i]) ?? '';
    if (!line) continue;
    if (++lines > TEST_LAB_LIMITS.importLines) {
      errors.push({line: n, message: IMPORT_TOO_MANY_MESSAGE});
      break;
    }
    if (line.length < 3) errors.push({line: n, message: `Line ${n} is too short: at least 3 characters.`});
    else if (line.length > TEST_LAB_LIMITS.question) errors.push({line: n, message: `Line ${n} is too long: up to ${TEST_LAB_LIMITS.question} characters.`});
    else if (hasControlChars(line)) errors.push({line: n, message: `Line ${n} has characters that can't be saved.`});
    else {
      const q = questionOf(line);
      if (typeof q === 'string') errors.push({line: n, message: `Line ${n} needs a question with words in it.`});
      else if (!seen.has(q.key)) {
        seen.add(q.key);
        questions.push({line: n, question: q.question, key: q.key});
      }
    }
  }
  return {questions, errors};
}

/** What a case expects: a cited answer, or a hand-off to a person. */
export const TEST_EXPECTS = ['answer', 'handoff'] as const;
export type TestExpect = (typeof TEST_EXPECTS)[number];

export const isTestExpect = (value: unknown): value is TestExpect =>
  typeof value === 'string' && (TEST_EXPECTS as readonly string[]).includes(value);

export const TEST_OUTCOMES = [
  'pass',
  'handoff',
  'person',
  'no_source',
  'wrong_source',
  'answered_instead',
  'cap',
  'error',
] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

/** How each outcome reads on the screen. */
export const TEST_OUTCOME_LABELS: Record<TestOutcome, string> = {
  pass: 'Passed',
  handoff: 'Handed off',
  person: 'Handed off by a rule',
  no_source: 'No source found',
  wrong_source: 'Cited a different article',
  answered_instead: 'Answered instead of handing off',
  cap: 'Skipped: monthly AI limit reached',
  error: "Couldn't run",
};

export interface TestCaseRow {
  id: number;
  question: string;
  expect: TestExpect;
  expectedArticle: {id: number; title: string; status: string} | null;
  lastAnswer: string | null;
  lastConfidence: 'high' | 'medium' | 'low' | 'none' | null;
  lastSources: {id: number | null; title: string; url: string}[];
  lastOutcome: TestOutcome | null;
  lastPassed: boolean | null;
  lastRunAt: string | null;
  lastRunId: number | null;
}

export interface TestRunView {
  id: number;
  state: 'running' | 'done' | 'cancelled' | 'stopped' | 'failed';
  stopReason: 'cap' | 'ai_off' | 'not_started' | 'stalled' | 'error' | null;
  total: number;
  done: number;
  passed: number;
  cursor: number;
  costCents: number;
  createdAt: string;
  finishedAt: string | null;
}

export type LaunchBand = 'ready' | 'almost' | 'not_ready' | 'none';

export interface LaunchScore {
  score: number | null;
  band: LaunchBand;
  ran: number;
  passed: number;
  total: number;
}

export const LAUNCH_BAND_LABELS: Record<LaunchBand, string> = {
  ready: 'Ready to launch',
  almost: 'Almost there',
  not_ready: 'Not ready yet',
  none: 'Run your tests to get a score',
};

export interface TestCasesPage {
  items: TestCaseRow[];
  next: number | null;
  total: number;
  run: TestRunView | null;
  score: LaunchScore;
}

/** Fewer tested questions than this can't earn a full score. */
const FULL_COVERAGE = 20;

/**
 * The "Ready to launch" score of the latest run (pure). Only scored cases count (`run.done`;
 * cap/error skips don't). A running run gives its live partial score; only a finished (`done`)
 * run with at least 10 scored cases can be `ready`.
 */
export function launchScore(run: TestRunView | null, totalCases: number): LaunchScore {
  const ran = run ? Math.max(0, run.done) : 0;
  const passed = run ? Math.min(Math.max(0, run.passed), ran) : 0;
  if (!run || ran === 0) return {score: null, band: 'none', ran, passed, total: totalCases};
  const coverage = Math.min(1, ran / FULL_COVERAGE);
  const score = Math.round(100 * (passed / ran) * (0.6 + 0.4 * coverage));
  const band: LaunchBand =
    score >= 85 && ran >= 10 && run.state === 'done' ? 'ready' : score >= 60 ? 'almost' : 'not_ready';
  return {score, band, ran, passed, total: totalCases};
}
