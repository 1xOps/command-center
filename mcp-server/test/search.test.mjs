import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolateConfig, scratch } from './helpers.mjs';

isolateConfig();
const { loadConfig } = await import('../dist/config.js');
const { search } = await import('../dist/search.js');
await loadConfig();

function tree(t) {
  const dir = scratch(t, 'search');
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'app.ts'), 'const token = 1;\nexport function Run() {}\n');
  writeFileSync(path.join(dir, 'src', 'notes.md'), 'TODO: run tests\n');
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'const token = 2;\n');
  return dir;
}

const base = { kind: 'content', ignoreCase: false, literal: false, maxResults: 100, timeoutMs: 10_000 };

test('content search finds file:line:text and filters by glob', async (t) => {
  const dir = tree(t);
  const result = await search({ ...base, path: dir, pattern: 'token', glob: '*.ts' });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0], /app\.ts:1:const token = 1;/);
});

test('ignore_case and literal', async (t) => {
  const dir = tree(t);
  const result = await search({ ...base, path: dir, pattern: 'run', ignoreCase: true, literal: true, glob: '*.md' });
  assert.equal(result.matches.length, 1);
});

test('file-name search', async (t) => {
  const dir = tree(t);
  const result = await search({ ...base, path: dir, pattern: 'notes', kind: 'files' });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0], /notes\.md$/);
});

test('max_results stops the search and says so', async (t) => {
  const dir = scratch(t, 'search');
  writeFileSync(path.join(dir, 'many.txt'), 'hit\n'.repeat(50));
  const result = await search({ ...base, path: dir, pattern: 'hit', maxResults: 5 });
  assert.equal(result.matches.length, 5);
});

test('an invalid regular expression is reported before searching', async (t) => {
  const dir = tree(t);
  await assert.rejects(search({ ...base, path: dir, pattern: '(' }), /invalid regular expression/);
});

// The built-in search is what users without ripgrep get; test it directly.
const { nodeSearch } = await import('../dist/search.js');

test('built-in search: matches, glob, skipped folders and binary files, truncation', async (t) => {
  const dir = tree(t);
  writeFileSync(path.join(dir, 'src', 'blob.bin'), Buffer.from([0x74, 0x6f, 0x6b, 0x65, 0x6e, 0]));
  const found = await nodeSearch(dir, { ...base, path: dir, pattern: 'token' });
  assert.equal(found.engine, 'node');
  assert.equal(found.matches.length, 1, 'node_modules is skipped');
  assert.match(found.matches[0], /app\.ts:1:/);
  assert.ok(found.warnings.some((w) => /binary/.test(w)), found.warnings.join('; '));
  const many = scratch(t, 'search');
  writeFileSync(path.join(many, 'many.txt'), 'hit\n'.repeat(50));
  const cut = await nodeSearch(many, { ...base, path: many, pattern: 'hit', maxResults: 5 });
  assert.equal(cut.matches.length, 5);
  assert.equal(cut.truncated, true);
});

test('a catastrophic regular expression is stopped at the timeout, not frozen', async (t) => {
  const { nodeSearchInWorker } = await import('../dist/search.js');
  const dir = scratch(t, 'search');
  writeFileSync(path.join(dir, 'slow.txt'), `${'a'.repeat(40)}!\n`);
  const started = Date.now();
  const result = await nodeSearchInWorker(dir, { ...base, path: dir, pattern: '(a+)+$', timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

const { startSearch, moreResults, stopSearch } = await import('../dist/search.js');

test('paged search: first page, later pages, then stop frees it', async (t) => {
  const dir = scratch(t, 'search');
  writeFileSync(path.join(dir, 'many.txt'), 'hit\n'.repeat(250));
  const first = await startSearch({ ...base, path: dir, pattern: 'hit', maxResults: 1000 }, 10_000, 100);
  assert.equal(first.running, false);
  assert.equal(first.totalSoFar, 250);
  assert.equal(first.matches.length, 100);
  const third = await moreResults(first.id, 200, 100, 0);
  assert.equal(third.matches.length, 50);
  assert.match(third.matches[0], /many\.txt:201:hit/);
  assert.equal((await stopSearch(first.id))?.running, false, 'stopping keeps the results');
  assert.equal((await moreResults(first.id, 0, 1, 0)).matches.length, 1);
  await stopSearch(first.id);
  await assert.rejects(moreResults(first.id, 0, 10, 0), /no search with id/);
});

test('paged search: a bad pattern fails at start; a failing search reports its error', async (t) => {
  const dir = scratch(t, 'search');
  await assert.rejects(startSearch({ ...base, path: dir, pattern: '(' }, 0, 10), /invalid regular expression/);
  const missing = await startSearch({ ...base, path: path.join(dir, 'missing'), pattern: 'x' }, 10_000, 10);
  assert.equal(missing.running, false);
  assert.ok(missing.error, 'the error is reported, not an empty success');
  await stopSearch(missing.id);
  await stopSearch(missing.id);
});

test('paged search: results show while it runs; stop ends it and keeps what it found', async (t) => {
  const dir = scratch(t, 'search');
  // Many small files: the search takes long enough to be stopped part-way on every engine.
  for (let i = 0; i < 400; i++) writeFileSync(path.join(dir, `f${i}.txt`), 'hit\n'.repeat(50));
  const first = await startSearch({ ...base, path: dir, pattern: 'hit', maxResults: 10_000, timeoutMs: 60_000 }, 10_000, 10);
  assert.equal(first.matches.length, 10, 'the first page arrives before the search is over');
  const stopped = await stopSearch(first.id);
  assert.ok(stopped, 'the search was found');
  assert.ok(stopped.totalSoFar >= 10, `kept ${stopped.totalSoFar} results`);
  const kept = await moreResults(first.id, 0, 5, 0);
  assert.equal(kept.running, false);
  assert.equal(kept.matches.length, 5, 'results found before the stop stay readable');
  const freed = await stopSearch(first.id);
  assert.equal(freed?.running, false);
  await assert.rejects(moreResults(first.id, 0, 1, 0), /no search with id/);
});

test('built-in engine: an abort before the worker starts still ends it at once', async (t) => {
  const { nodeSearchInWorker } = await import('../dist/search.js');
  const dir = scratch(t, 'search');
  writeFileSync(path.join(dir, 'slow.txt'), `${'a'.repeat(40)}!\n`);
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await nodeSearchInWorker(dir, { ...base, path: dir, pattern: '(a+)+$', timeoutMs: 60_000 }, controller.signal);
  assert.deepEqual(result.warnings, ['stopped']);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('built-in engine: a stop part-way returns the matches found so far', async (t) => {
  const { nodeSearchInWorker } = await import('../dist/search.js');
  const dir = scratch(t, 'search');
  for (let i = 0; i < 400; i++) writeFileSync(path.join(dir, `f${i}.txt`), 'hit\n'.repeat(50));
  const controller = new AbortController();
  const seen = [];
  const pending = nodeSearchInWorker(dir, { ...base, path: dir, pattern: 'hit', maxResults: 100_000, timeoutMs: 60_000 }, controller.signal,
    (m) => { seen.push(m); if (seen.length === 200) controller.abort(); });
  const result = await pending;
  assert.ok(result.matches.length >= 200, `${result.matches.length} matches kept`);
  assert.ok(result.matches.length < 20_000, 'stopped before the end');
});
