// Offline-queue policy unit tests — no browser: public/queue.js is loaded
// into a VM context. These rules govern all three phone queues (photo outbox,
// text queue, file queue); the flush-decision bug class they pin is "one bad
// head blocked the whole queue" and "poisoned items re-sent forever".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// top-level const doesn't attach to the context — the module exports via self
const ctx = { self: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(APP, 'public', 'queue.js'), 'utf8'), ctx);
const Q = ctx.self.PPQueue;
// arrays returned from the VM realm have a foreign Array prototype — unwrap
// to local-realm arrays so deepStrictEqual compares structurally
const local = v => JSON.parse(JSON.stringify(v));

// ---------- backoff ----------
test('backoff: 5s doubling capped at 5min', () => {
  assert.equal(Q.backoffMs(0), 5000);
  assert.equal(Q.backoffMs(1), 10000);
  assert.equal(Q.backoffMs(2), 20000);
  assert.equal(Q.backoffMs(3), 40000);
  assert.equal(Q.backoffMs(6), 300000, 'already capped (5000·2⁶ > 5min)');
  assert.equal(Q.backoffMs(7), 300000, 'capped at 5 minutes');
  assert.equal(Q.backoffMs(99), 300000);
  assert.equal(Q.backoffMs(undefined), 5000, 'missing tries = first attempt');
});

// ---------- decide ----------
const NOW = 1_000_000_000;

test('decide: fresh item sends; cooling item skips with the remaining wait honored', () => {
  assert.equal(Q.decide({ tries: 0, lastAttempt: 0 }, { now: NOW }), 'send', 'never attempted → send');
  assert.equal(Q.decide({}, { now: NOW }), 'send', 'empty item → send');
  // 1 try → 10s backoff; 9s after lastAttempt → still cooling
  assert.equal(Q.decide({ tries: 1, lastAttempt: NOW - 9000 }, { now: NOW }), 'skip-backoff');
  // exactly at the boundary (10s elapsed) → send again
  assert.equal(Q.decide({ tries: 1, lastAttempt: NOW - 10000 }, { now: NOW }), 'send');
});

test('decide: poisoned items never send but are distinct from backoff skips', () => {
  assert.equal(Q.decide({ tries: 999, lastAttempt: 0 }, { now: NOW }), 'skip-poison');
  assert.equal(Q.decide({ tries: 1000 }, { now: NOW }), 'skip-poison');
  // poison wins over inflight/backoff distinctions — it is a terminal state
  assert.equal(Q.decide({ tries: 999 }, { now: NOW, inflight: true }), 'skip-poison');
});

test('decide: inflight (manual retry owns the item) skips regardless of backoff', () => {
  assert.equal(Q.decide({ tries: 0, lastAttempt: 0 }, { now: NOW, inflight: true }), 'skip-inflight');
});

// ---------- onFailure ----------
test('onFailure: transient failure bumps tries and stamps lastAttempt', () => {
  const book = Q.onFailure({ tries: 2, lastAttempt: 1 }, 500, { now: NOW });
  assert.deepEqual(local(book), { tries: 3, lastAttempt: NOW });
  // network error (no status) behaves like transient
  const book2 = Q.onFailure({ tries: 0 }, undefined, { now: NOW });
  assert.equal(book2.tries, 1);
  assert.equal(book2.poisoned, undefined);
});

test('onFailure: 429 bumps tries AND asks everyone to pause (bucket refill)', () => {
  const book = Q.onFailure({ tries: 1, lastAttempt: 1 }, 429, { now: NOW });
  assert.equal(book.tries, 2);
  assert.equal(book.lastAttempt, NOW);
  assert.equal(book.rateLimitedMs, 1500);
  assert.equal(book.poisoned, undefined);
});

test('onFailure: 413 poisons the item (never re-sent, stays visible)', () => {
  const book = Q.onFailure({ tries: 0, lastAttempt: 1 }, 413, { now: NOW });
  assert.equal(book.tries, Q.POISON_TRIES, '413 → poison');
  assert.equal(book.poisoned, true);
  assert.equal(Q.decide({ tries: book.tries, lastAttempt: book.lastAttempt }, { now: book.lastAttempt + 1 }), 'skip-poison');
});

test('onFailure: 415 is retryable backoff, not poison (a newer server may accept the format)', () => {
  const book = Q.onFailure({ tries: 2, lastAttempt: 1 }, 415, { now: NOW });
  assert.equal(book.tries, 3);
  assert.equal(book.poisoned, undefined);
  // after the backoff window it sends again — the queue self-heals once the
  // server learns the format (e.g. HEIC)
  assert.equal(Q.decide({ tries: book.tries, lastAttempt: book.lastAttempt }, { now: book.lastAttempt + Q.backoffMs(book.tries) }), 'send');
});

// ---------- text queue capacity ----------
test('text queue: 20 cap, 5-cap fallback when storage quota is hit, newest kept', () => {
  const twentyfive = Array.from({ length: 25 }, (_, i) => ({ body: String(i) }));
  assert.equal(Q.trimTexts(twentyfive).length, 20);
  assert.equal(Q.trimTexts(twentyfive)[0].body, '5', 'newest kept — oldest dropped');
  assert.equal(Q.trimTextsFallback(twentyfive).length, 5);
  assert.equal(Q.trimTextsFallback(twentyfive)[0].body, '20');
  assert.deepEqual(local(Q.trimTexts('garbage')), [], 'non-array input cannot crash the queue');
  assert.deepEqual(local(Q.trimTexts([])), []);
});

// ---------- planFlush ----------
test('planFlush: sends in queue order; bad heads skip individually, never block the queue', () => {
  const items = [
    { key: 'a', value: { tries: 1, lastAttempt: NOW - 1000 } },  // cooling (9s of 10s)
    { key: 'b', value: { tries: 0, lastAttempt: 0 } },           // fresh
    { key: 'c', value: { tries: 999 } },                          // poisoned
    { key: 'd', value: { tries: 2, lastAttempt: NOW - 60000 } }, // cooled down
  ];
  const plan = Q.planFlush(items, { now: NOW, inflightKeys: [] });
  assert.deepEqual(local(plan.send), ['b', 'd'], 'a and c skip, b and d send in order');
  assert.deepEqual(local(plan.keep), ['a', 'c']);
});

test('planFlush: inflight keys are excluded (manual retry owns them)', () => {
  const items = [
    { key: 'x', value: { tries: 0 } },
    { key: 'y', value: { tries: 0 } },
  ];
  const plan = Q.planFlush(items, { now: NOW, inflightKeys: ['x'] });
  assert.deepEqual(local(plan.send), ['y']);
  assert.deepEqual(local(plan.keep), ['x']);
});

test('planFlush: empty/garbage input yields an empty plan', () => {
  assert.deepEqual(local(Q.planFlush([], { now: NOW }).send), []);
  assert.deepEqual(local(Q.planFlush(null, { now: NOW }).send), []);
});

// ---------- unpoison (one-time migration for the old 415-poison policy) ----------
test('unpoison: old-policy poison (999) revives with a clean slate', () => {
  assert.deepEqual(local(Q.unpoison({ tries: 999, lastAttempt: 123 })), { tries: 0, lastAttempt: 0 });
  // revived items must be immediately sendable
  assert.equal(Q.decide({ tries: 0, lastAttempt: 0 }, { now: NOW }), 'send');
});

test('unpoison: oversized items (413 terminal) stay poisoned', () => {
  assert.equal(Q.unpoison({ tries: 999, lastAttempt: 1, poisonReason: 'too-large' }), null);
});

test('unpoison: non-poisoned and garbage inputs are left untouched', () => {
  assert.equal(Q.unpoison({ tries: 3 }), null);
  assert.equal(Q.unpoison({}), null);
  assert.equal(Q.unpoison(null), null);
  assert.equal(Q.unpoison(undefined), null);
});

test('unpoison: oversized blobs re-poison on the first 413 (self-healing loop)', () => {
  // revived too-large item re-fails → onFailure(413) re-poisons with the marker
  const book = Q.onFailure({ tries: 0 }, 413, { now: NOW });
  assert.equal(Q.decide(book, { now: NOW }), 'skip-poison');
});
