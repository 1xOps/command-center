import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validatePath } from './policy.js';

export interface SearchInput {
  path: string;
  pattern: string;
  kind: 'content' | 'files';
  glob?: string | undefined;
  ignoreCase: boolean;
  literal: boolean;
  maxResults: number;
  timeoutMs: number;
}

export interface SearchResult {
  engine: 'ripgrep' | 'node';
  matches: string[];
  truncated: boolean;
  timedOut: boolean;
  /** Anything that makes the results incomplete: unreadable files or folders, skipped files. */
  warnings: string[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const NODE_MAX_FILE_BYTES = 4 * 1024 * 1024;

let rgAvailable: Promise<boolean> | undefined;
function hasRipgrep(): Promise<boolean> {
  rgAvailable ??= new Promise((resolve) => execFile('rg', ['--version'], (error) => resolve(!error)));
  return rgAvailable;
}

/** Called with each match as it is found, so a paged search can show results while it runs. */
export type MatchSink = (match: string) => void;

function ripgrep(root: string, input: SearchInput, signal?: AbortSignal, onMatch?: MatchSink): Promise<SearchResult> {
  const args = input.kind === 'files'
    ? ['--files', '--color', 'never']
    : ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '500'];
  if (input.glob) args.push('--glob', input.glob);
  if (input.kind === 'content') {
    if (input.ignoreCase) args.push('--ignore-case');
    if (input.literal) args.push('--fixed-strings');
    args.push('--regexp', input.pattern);
  }
  args.push('--', root);
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const matches: string[] = [];
    let buffered = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, input.timeoutMs);
    // An abort that arrived before the spawn would never fire the listener, so check first.
    if (signal?.aborted) child.kill('SIGKILL');
    else signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        // In files mode rg lists every file; filter names by the pattern here.
        if (input.kind === 'files' && !nameMatches(line, input)) continue;
        if (matches.length >= input.maxResults) { truncated = true; child.kill('SIGKILL'); return; }
        matches.push(line);
        onMatch?.(line);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // rg exits 1 for "no matches" and 2 for errors (bad regex, unreadable files). Errors with
      // no results fail the call; errors alongside results are reported as warnings.
      if (code === 2 && !truncated && !timedOut && matches.length === 0) return reject(new Error(`ripgrep: ${stderr.trim()}`));
      const warnings = code === 2 ? stderr.trim().split('\n').slice(0, 5).map((l) => `ripgrep: ${l}`) : [];
      resolve({ engine: 'ripgrep', matches, truncated, timedOut, warnings });
    });
  });
}

/** File-name search is plain text, so no user regular expression runs on the main thread. */
function nameMatches(file: string, input: SearchInput): boolean {
  const name = path.basename(file);
  return input.ignoreCase ? name.toLowerCase().includes(input.pattern.toLowerCase()) : name.includes(input.pattern);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export async function nodeSearch(root: string, input: SearchInput, onMatch?: MatchSink): Promise<SearchResult> {
  const deadline = Date.now() + input.timeoutMs;
  const matcher = input.literal
    ? undefined
    : new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
  const needle = input.ignoreCase ? input.pattern.toLowerCase() : input.pattern;
  const globRe = input.glob ? globToRegExp(input.glob) : undefined;
  const result: SearchResult = { engine: 'node', matches: [], truncated: false, timedOut: false, warnings: [] };
  const skipped = { large: 0, binary: 0, unreadable: 0, unreadableFolders: 0 };
  const contains = (text: string) => (matcher ? matcher.test(text) : (input.ignoreCase ? text.toLowerCase() : text).includes(needle));

  async function visit(file: string): Promise<void> {
    if (globRe && !globRe.test(path.basename(file))) return;
    if (input.kind === 'files') {
      if (nameMatches(file, input)) {
        if (result.matches.length >= input.maxResults) { result.truncated = true; return; }
        result.matches.push(file);
        onMatch?.(file);
      }
      return;
    }
    let buffer;
    try {
      if ((await stat(file)).size > NODE_MAX_FILE_BYTES) { skipped.large++; return; }
      buffer = await readFile(file);
    } catch {
      skipped.unreadable++;
      return;
    }
    if (buffer.subarray(0, 8192).includes(0)) { skipped.binary++; return; }
    const lines = buffer.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!contains(lines[i] ?? '')) continue;
      if (result.matches.length >= input.maxResults) { result.truncated = true; return; }
      const match = `${file}:${i + 1}:${(lines[i] ?? '').slice(0, 500)}`;
      result.matches.push(match);
      onMatch?.(match);
    }
  }

  async function walk(dir: string): Promise<void> {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { skipped.unreadableFolders++; return; }
    for (const item of items) {
      if (result.truncated) return;
      if (Date.now() > deadline) { result.timedOut = true; return; }
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { if (!SKIP_DIRS.has(item.name)) await walk(full); }
      else if (item.isFile()) await visit(full);
    }
  }

  const info = await stat(root);
  if (info.isFile()) await visit(root);
  else await walk(root);
  if (skipped.unreadable) result.warnings.push(`${skipped.unreadable} file(s) could not be read`);
  if (skipped.unreadableFolders) result.warnings.push(`${skipped.unreadableFolders} folder(s) could not be read`);
  if (skipped.large) result.warnings.push(`${skipped.large} file(s) over ${NODE_MAX_FILE_BYTES / 1024 / 1024} MiB skipped (install ripgrep to search them)`);
  if (skipped.binary) result.warnings.push(`${skipped.binary} binary file(s) skipped`);
  return result;
}

type WorkerMessage = { batch: string[] } | { ok: true; result: SearchResult } | { ok: false; error: string };

/**
 * The built-in search in a worker thread, terminated if it outlives the timeout or is aborted.
 * The worker sends matches in batches as it finds them; a stopped or timed-out search returns
 * what it found so far.
 */
export function nodeSearchInWorker(root: string, input: SearchInput, signal?: AbortSignal, onMatch?: MatchSink): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    const found: string[] = [];
    let settled = false;
    const worker = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: { root, input } });
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      outcome();
    };
    const partial = (timedOut: boolean, warning: string): SearchResult =>
      ({ engine: 'node', matches: found, truncated: false, timedOut, warnings: [warning] });
    const onAbort = () => finish(() => resolve(partial(false, 'stopped')));
    const timer = setTimeout(() => finish(() => resolve(partial(true,
      `stopped after ${input.timeoutMs} ms; try a simpler pattern, literal: true, or install ripgrep`))), input.timeoutMs + 1000);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: WorkerMessage) => {
      if ('batch' in message) {
        for (const m of message.batch) { found.push(m); onMatch?.(m); }
        return;
      }
      if (message.ok) finish(() => resolve({ ...message.result, matches: found }));
      else finish(() => reject(new Error(message.error)));
    });
    worker.once('error', (error) => finish(() => reject(error)));
  });
}

export async function search(input: SearchInput, signal?: AbortSignal, onMatch?: MatchSink): Promise<SearchResult> {
  const root = await validatePath(input.path);
  if (input.kind === 'content' && !input.literal) {
    // Compiling checks the syntax and is safe; matching runs in ripgrep or in the worker.
    try { new RegExp(input.pattern); } catch (error) { throw new Error(`invalid regular expression: ${(error as Error).message}; set literal: true to search plain text`); }
  }
  return (await hasRipgrep()) ? ripgrep(root, input, signal, onMatch) : nodeSearchInWorker(root, input, signal, onMatch);
}

// ---- Paged searches ------------------------------------------------------------------------
// start_search runs a search in the background and keeps its results for paging, so a large
// result set is read a page at a time and results show while it still runs. Bounded: at most
// MAX_SEARCHES kept (the least recently read finished one makes room for a new one), and each is
// dropped IDLE_MS after its last read. stop_search ends a search and keeps what it found; a second
// stop_search frees it.

const MAX_SEARCHES = 10;
const IDLE_MS = 10 * 60_000;

interface SearchSession {
  id: string;
  input: SearchInput;
  controller: AbortController;
  done: Promise<void>;
  matches: string[];
  finished: boolean;
  stopped: boolean;
  result?: SearchResult;
  error?: string;
  lastUsed: number;
}

const sessions = new Map<string, SearchSession>();
let nextId = 1;

function drop(s: SearchSession): void {
  s.controller.abort();
  sessions.delete(s.id);
}

function sweep(): void {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUsed > IDLE_MS) drop(s);
  if (sessions.size === 0 && sweeper) { clearInterval(sweeper); sweeper = undefined; }
}
let sweeper: NodeJS.Timeout | undefined;

/** Makes room for one more search, or throws when every kept search is still running. */
function reserve(): void {
  sweep();
  if (sessions.size < MAX_SEARCHES) return;
  const idle = [...sessions.values()].filter((s) => s.finished).sort((a, b) => a.lastUsed - b.lastUsed)[0];
  if (!idle) throw new Error(`${MAX_SEARCHES} searches are still running; stop_search one first`);
  drop(idle);
}

export interface SearchPage {
  id: string;
  running: boolean;
  stopped: boolean;
  offset: number;
  matches: string[];
  totalSoFar: number;
  truncated: boolean;
  timedOut: boolean;
  warnings: string[];
  error?: string;
}

function page(s: SearchSession, offset: number, length: number): SearchPage {
  s.lastUsed = Date.now();
  const base = {
    id: s.id, running: !s.finished, stopped: s.stopped, offset, matches: s.matches.slice(offset, offset + length),
    totalSoFar: s.matches.length, truncated: s.result?.truncated ?? false, timedOut: s.result?.timedOut ?? false,
    warnings: s.result?.warnings ?? [],
  };
  return s.error ? { ...base, error: s.error } : base;
}

/** Waits for the search to finish or for `want` results, whichever comes first, up to `ms`. */
async function waitFor(s: SearchSession, want: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!s.finished && s.matches.length < want && Date.now() < deadline) {
    await Promise.race([s.done, new Promise<void>((r) => setTimeout(r, Math.min(50, deadline - Date.now())).unref())]);
  }
}

function validatePattern(input: SearchInput): void {
  if (input.kind === 'content' && !input.literal) {
    try { new RegExp(input.pattern); } catch (error) { throw new Error(`invalid regular expression: ${(error as Error).message}; set literal: true to search plain text`); }
  }
}

/**
 * Validates first (a bad path or pattern fails the call), then runs in the background and
 * returns as soon as the first page is full, the search finishes, or waitMs passes.
 */
export async function startSearch(input: SearchInput, waitMs: number, pageSize: number): Promise<SearchPage> {
  validatePattern(input);
  await validatePath(input.path);
  // Reserved after the last await, so concurrent calls cannot exceed MAX_SEARCHES.
  reserve();
  const id = `search-${nextId++}`;
  const controller = new AbortController();
  const s: SearchSession = { id, input, controller, done: Promise.resolve(), matches: [], finished: false, stopped: false, lastUsed: Date.now() };
  s.done = search(input, controller.signal, (m) => { s.matches.push(m); }).then(
    (r) => { s.result = r; },
    (e: unknown) => { s.error = e instanceof Error ? e.message : String(e); },
  ).finally(() => { s.finished = true; });
  sessions.set(id, s);
  sweeper ??= setInterval(sweep, 60_000).unref();
  await waitFor(s, pageSize, waitMs);
  return page(s, 0, pageSize);
}

export async function moreResults(id: string, offset: number, length: number, waitMs: number): Promise<SearchPage> {
  sweep();
  const s = sessions.get(id);
  if (!s) throw new Error(`no search with id ${id} (searches are kept for ${IDLE_MS / 60_000} minutes after the last read)`);
  await waitFor(s, offset + length, waitMs);
  return page(s, offset, length);
}

/**
 * The first call stops the search (if still running) and keeps what it found, readable with
 * moreResults; a second call frees the results.
 */
export async function stopSearch(id: string): Promise<SearchPage | undefined> {
  const s = sessions.get(id);
  if (!s) return undefined;
  if (s.stopped) { drop(s); return page(s, 0, 0); }
  s.stopped = true;
  s.controller.abort();
  await s.done;
  return page(s, 0, 0);
}

/** True while a search with this id is kept. */
export function sessionsKept(id: string): boolean {
  return sessions.has(id);
}

export function stopAllSearches(): void {
  for (const s of [...sessions.values()]) drop(s);
}
