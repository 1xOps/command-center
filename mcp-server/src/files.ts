import { appendFile, lstat, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { validatePath } from './policy.js';

const MAX_READ_BYTES = 64 * 1024 * 1024; // larger files: use start_process with tail/head/grep
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const FUZZY_MAX_LINES = 5000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export type ReadResult =
  | { kind: 'text'; path: string; text: string; fromLine: number; toLine: number; totalLines: number }
  | { kind: 'image'; path: string; data: string; mimeType: string };

async function isBinary(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Reads lines `offset`..`offset+length` (0-based). A negative offset reads from the end, so
 * `offset: -100` is the last 100 lines of a log.
 */
export async function readTextOrImage(requested: string, offset = 0, length?: number): Promise<ReadResult> {
  const file = await validatePath(requested);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error(`${requested} is a directory; use list_directory`);
  const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (mimeType) {
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`${requested} is ${info.size} bytes; images up to ${MAX_IMAGE_BYTES} bytes are returned`);
    return { kind: 'image', path: file, data: (await readFile(file)).toString('base64'), mimeType };
  }
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`${requested} is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read limit; use start_process with tail, head or grep`);
  }
  if (await isBinary(file)) throw new Error(`${requested} is a binary file; only text and images (png, jpg, gif, webp) are read`);
  const lines = (await readFile(file, 'utf8')).split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const limit = Math.min(length ?? getConfig().fileReadLineLimit, getConfig().fileReadLineLimit);
  const from = offset < 0 ? Math.max(lines.length + offset, 0) : Math.min(offset, lines.length);
  const to = Math.min(from + limit, lines.length);
  return { kind: 'text', path: file, text: lines.slice(from, to).join('\n'), fromLine: from + 1, toLine: to, totalLines: lines.length };
}

export async function writeText(requested: string, content: string, mode: 'rewrite' | 'append'): Promise<{ path: string; lines: number }> {
  const file = await validatePath(requested);
  const lines = content.split('\n').length;
  const limit = getConfig().fileWriteLineLimit;
  if (lines > limit) {
    throw new Error(`content is ${lines} lines, over fileWriteLineLimit (${limit}); write the first ${limit} lines with mode "rewrite", then the rest with mode "append"`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (mode === 'append') await appendFile(file, content, 'utf8');
  else await writeFile(file, content, 'utf8');
  return { path: file, lines };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) count++;
  return count;
}

/** Levenshtein distance with two rows: O(a·b) time, O(b) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, row] = [row, prev];
  }
  return prev[b.length] ?? 0;
}

function closestWindow(text: string, search: string): { fromLine: number; toLine: number; similarity: number; snippet: string } | undefined {
  const lines = text.split('\n');
  const span = search.split('\n').length;
  if (lines.length > FUZZY_MAX_LINES || span > lines.length) return undefined;
  let best: { fromLine: number; toLine: number; similarity: number; snippet: string } | undefined;
  for (let i = 0; i + span <= lines.length; i++) {
    const snippet = lines.slice(i, i + span).join('\n');
    const longest = Math.max(snippet.length, search.length) || 1;
    const similarity = 1 - levenshtein(snippet, search) / longest;
    if (!best || similarity > best.similarity) best = { fromLine: i + 1, toLine: i + span, similarity, snippet };
  }
  return best;
}

/**
 * Replaces `oldString` with `newString` only when it occurs exactly `expected` times. With no
 * exact match it changes nothing and reports the closest passage, so the caller can retry with
 * the file's real text.
 */
export async function editBlock(requested: string, oldString: string, newString: string, expected = 1): Promise<string> {
  if (oldString === '') throw new Error('old_string is empty; use write_file to create or replace a whole file');
  const file = await validatePath(requested);
  const text = await readFile(file, 'utf8');
  const count = countOccurrences(text, oldString);
  if (count === expected) {
    await writeFile(file, text.split(oldString).join(newString), 'utf8');
    return `replaced ${count} occurrence${count === 1 ? '' : 's'} in ${file}`;
  }
  if (count > 0) {
    throw new Error(`old_string occurs ${count} times in ${file}, expected ${expected}; set expected_replacements to ${count} or add surrounding lines to make it unique`);
  }
  const near = closestWindow(text, oldString);
  if (!near) throw new Error(`old_string was not found in ${file}; nothing changed`);
  throw new Error(
    `old_string was not found in ${file}; nothing changed. Closest passage, lines ${near.fromLine}-${near.toLine} ` +
      `(${Math.round(near.similarity * 100)}% similar):\n${near.snippet}`,
  );
}

export async function listDirectory(requested: string, depth: number): Promise<{ path: string; entries: string[]; truncated: boolean }> {
  const root = await validatePath(requested);
  const entries: string[] = [];
  let truncated = false;
  async function walk(dir: string, level: number): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The folder that was asked for must exist and be readable; say so instead of listing nothing.
      if (dir === root) throw new Error(`cannot list ${requested}: ${code === 'ENOTDIR' ? 'it is a file' : (error as Error).message}`);
      const label = code === 'EACCES' || code === 'EPERM' ? 'DENIED' : `ERROR ${code}`;
      entries.push(`[${label}] ${path.relative(root, dir)}/`);
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      const rel = path.relative(root, path.join(dir, item.name));
      if (item.isDirectory()) {
        entries.push(`[DIR] ${rel}/`);
        if (level < depth) await walk(path.join(dir, item.name), level + 1);
      } else {
        entries.push(`[${item.isSymbolicLink() ? 'LINK' : 'FILE'}] ${rel}`);
      }
    }
  }
  await walk(root, 1);
  return { path: root, entries, truncated };
}

export async function fileInfo(requested: string): Promise<{ path: string; type: string; size: number; modified: string; created: string; mode: string; lines?: number }> {
  const file = await validatePath(requested);
  const info = await stat(file);
  const result: { path: string; type: string; size: number; modified: string; created: string; mode: string; lines?: number } = {
    path: file,
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    size: info.size,
    modified: info.mtime.toISOString(),
    created: info.birthtime.toISOString(),
    mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
  };
  if (info.isFile() && info.size <= MAX_READ_BYTES && !(await isBinary(file))) {
    result.lines = (await readFile(file, 'utf8')).split('\n').length;
  }
  return result;
}

export async function createDirectory(requested: string): Promise<string> {
  const dir = await validatePath(requested);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The entry itself (a link stays a link): its folder is resolved and checked, its name kept. */
async function validateEntry(requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  return path.join(await validatePath(path.dirname(absolute)), path.basename(absolute));
}

export async function moveFile(source: string, destination: string): Promise<{ from: string; to: string }> {
  const from = await validateEntry(source);
  const to = await validateEntry(destination);
  const [fromInfo, toInfo] = await Promise.all([lstat(from), lstat(to).catch(() => undefined)]);
  // On a case-insensitive filesystem `Foo` -> `foo` finds the source itself; that rename is fine.
  const sameEntry = toInfo && toInfo.ino === fromInfo.ino && toInfo.dev === fromInfo.dev;
  if (toInfo && !sameEntry) throw new Error(`${destination} already exists; nothing moved`);
  await rename(from, to);
  return { from, to };
}
