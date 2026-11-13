import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {launchScore, normalizeQuestion, TEST_OUTCOME_LABELS, TEST_OUTCOMES, type TestRunView} from '../src/lib/test-lab';
import {scoreOutcome} from '../src/server/knowledge/test-lab';

/** The "Ready to launch" score and the question key (src/lib/test-lab.ts). No database. */
function run(done: number, passed: number, state: TestRunView['state'] = 'done', total = done): TestRunView {
  return {id: 1, state, stopReason: null, total, done, passed, cursor: 0, costCents: 0, createdAt: '2026-11-13T00:00:00.000Z', finishedAt: null};
}

describe('launchScore', () => {
  it('no run, or nothing scored → none', () => {
    expect(launchScore(null, 8)).toEqual({score: null, band: 'none', ran: 0, passed: 0, total: 8});
    expect(launchScore(run(0, 0, 'stopped', 8), 8)).toEqual({score: null, band: 'none', ran: 0, passed: 0, total: 8});
  });

  it('the plan’s examples', () => {
    expect(launchScore(run(8, 8), 8)).toMatchObject({score: 76, band: 'almost', ran: 8, passed: 8});
    expect(launchScore(run(20, 18), 20)).toMatchObject({score: 90, band: 'ready'});
    expect(launchScore(run(20, 15), 20)).toMatchObject({score: 75, band: 'almost'});
  });

  it('coverage caps at 20 questions', () => {
    expect(launchScore(run(40, 40), 40).score).toBe(100);
    expect(launchScore(run(20, 20), 20).score).toBe(100);
    expect(launchScore(run(10, 10), 10)).toMatchObject({score: 80, band: 'almost'});
    expect(launchScore(run(1, 1), 1)).toMatchObject({score: 62, band: 'almost'});
  });

  it('ready needs score ≥ 85, ≥ 10 scored and a finished run', () => {
    expect(launchScore(run(15, 15), 15)).toMatchObject({score: 90, band: 'ready'});
    expect(launchScore(run(9, 9), 9)).toMatchObject({score: 78, band: 'almost'});
    expect(launchScore(run(20, 17), 20)).toMatchObject({score: 85, band: 'ready'});
    expect(launchScore(run(20, 16), 20)).toMatchObject({score: 80, band: 'almost'});
  });

  it('a running, stopped or cancelled run keeps its partial score but is never ready', () => {
    expect(launchScore(run(20, 20, 'running', 30), 30)).toMatchObject({score: 100, band: 'almost', ran: 20, total: 30});
    expect(launchScore(run(20, 20, 'stopped', 30), 30)).toMatchObject({score: 100, band: 'almost'});
    expect(launchScore(run(20, 20, 'cancelled', 30), 30)).toMatchObject({score: 100, band: 'almost'});
  });

  it('not ready below 60', () => {
    expect(launchScore(run(20, 11), 20)).toMatchObject({score: 55, band: 'not_ready'});
    expect(launchScore(run(20, 12), 20)).toMatchObject({score: 60, band: 'almost'});
    expect(launchScore(run(5, 0), 5)).toMatchObject({score: 0, band: 'not_ready'});
  });
});

describe('normalizeQuestion', () => {
  it('lower-cases, collapses spaces and drops trailing punctuation', () => {
    expect(normalizeQuestion('  How do I   CANCEL my\tsubscription?? ')).toBe('how do i cancel my subscription');
    expect(normalizeQuestion('Do you ship to Canada?!.')).toBe('do you ship to canada');
    expect(normalizeQuestion('Help ? ! .')).toBe('help');
    expect(normalizeQuestion('What is 2.5 kg?')).toBe('what is 2.5 kg');
    expect(normalizeQuestion('¿Cómo puedo rastrear mi pedido？')).toBe('¿cómo puedo rastrear mi pedido');
    expect(normalizeQuestion('注文はいつ届きますか。')).toBe('注文はいつ届きますか');
    expect(normalizeQuestion('???')).toBe('');
  });

  it('treats composed and decomposed accents as the same question', () => {
    expect(normalizeQuestion('Café au lait?')).toBe(normalizeQuestion('Café au lait'));
  });

  it('matches the keys written in prisma/seed.sql', () => {
    const seed = readFileSync(new URL('../prisma/seed.sql', import.meta.url), 'utf8');
    const block = seed.slice(seed.indexOf('INSERT INTO "test_cases"'));
    const rows = [...block.matchAll(/^\s+\(\d+, '((?:[^']|'')*)', '((?:[^']|'')*)', '(answer|handoff)'/gmu)];
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r[3] === 'handoff')).toHaveLength(2);
    for (const [, question, key] of rows) expect(normalizeQuestion(question!.replaceAll("''", "'"))).toBe(key!.replaceAll("''", "'"));
  });
});

describe('outcomes', () => {
  it('every outcome has a label', () => {
    for (const o of TEST_OUTCOMES) expect(TEST_OUTCOME_LABELS[o]).toBeTruthy();
    expect(TEST_OUTCOME_LABELS.answered_instead).toBe('Answered instead of handing off');
  });
});

describe('scoreOutcome', () => {
  const answer = {expect: 'answer', expectedArticleId: 5};
  const handoff = {expect: 'handoff', expectedArticleId: null};
  const MODEL = 'claude-opus-5-5';
  type Out = Parameters<typeof scoreOutcome>[1];
  const out = (status: Out['status'], confidence: Out['confidence'], model: string, cited: number[] = []): Out =>
    ({status, confidence, log: {model}, citedArticleIds: cited}) as Out;

  it('a failed AI call (hand-off, confidence none, a model) is an error, not scored, whatever the case expects', () => {
    expect(scoreOutcome(answer, out('handoff', 'none', MODEL), 5)).toEqual({outcome: 'error', passed: null});
    expect(scoreOutcome(handoff, out('handoff', 'none', MODEL), null)).toEqual({outcome: 'error', passed: null});
  });

  it('a rule hand-off (no model) and no_source score as before', () => {
    expect(scoreOutcome(answer, out('handoff', 'none', ''), 5)).toEqual({outcome: 'person', passed: false});
    expect(scoreOutcome(handoff, out('handoff', 'none', ''), null)).toEqual({outcome: 'pass', passed: true});
    expect(scoreOutcome(answer, out('no_source', 'none', ''), null)).toEqual({outcome: 'no_source', passed: false});
    expect(scoreOutcome(handoff, out('no_source', 'none', ''), null)).toEqual({outcome: 'no_source', passed: false});
  });

  it('a model hand-off (low confidence or needs a person) and answers score as before', () => {
    expect(scoreOutcome(answer, out('handoff', 'low', MODEL), 5)).toEqual({outcome: 'handoff', passed: false});
    expect(scoreOutcome(handoff, out('handoff', 'high', MODEL), null)).toEqual({outcome: 'pass', passed: true});
    expect(scoreOutcome(answer, out('answered', 'high', MODEL, [5]), 9)).toEqual({outcome: 'pass', passed: true});
    expect(scoreOutcome(answer, out('answered', 'high', MODEL, [7]), 9)).toEqual({outcome: 'wrong_source', passed: false});
    expect(scoreOutcome(handoff, out('answered', 'high', MODEL), null)).toEqual({outcome: 'answered_instead', passed: false});
    expect(scoreOutcome(answer, out('off', 'none', ''), 5)).toEqual({outcome: 'cap', passed: null});
  });
});
