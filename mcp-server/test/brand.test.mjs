// Ownership gate: every file in this repository is 1xOps work, owned by nnthanh101. No file may
// name an upstream project, and every author or copyright line must name the owner. There is
// no allowlist. The terms are built from fragments so this file does not match itself.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'tmp']);
const SKIP_FILES = new Set(['package-lock.json']);
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|tgz|mcpb|zip)$/i;
const term = (...parts) => new RegExp(parts.join(''), 'i');
const RESIDUE = [
  term('desk', 'top[\\s_-]?', 'commander'), term('wonder', 'why'), term('\\bruz', 'ga\\b'), term('\\beduar', 'ds?\\b'),
  term('server[\\s_-]', 'commander'), term('smith', 'ery'), /\bdc-[a-z]/, /\bDC\b/,
];
const OWNER = /1xOps|nnthanh101/;

function* files(rel = '.') {
  const full = path.join(repo, rel);
  const info = statSync(full);
  if (info.isFile()) { yield rel; return; }
  for (const name of readdirSync(full)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    yield* files(path.join(rel, name));
  }
}

const textFiles = () => [...files()].filter((rel) => !BINARY.test(rel));

test('no upstream name anywhere in the repository', () => {
  const hits = [];
  for (const rel of textFiles()) {
    readFileSync(path.join(repo, rel), 'utf8').split('\n').forEach((line, i) => {
      if (RESIDUE.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('no notice files: the work is the owner\'s alone', () => {
  assert.deepEqual(textFiles().filter((rel) => /(^|[\\/])(NOTICE|THIRD-PARTY-NOTICES)(\.md|\.txt)?$/i.test(rel)), []);
});

test('every copyright and author line names the owner', () => {
  const bad = [];
  for (const rel of textFiles()) {
    readFileSync(path.join(repo, rel), 'utf8').split('\n').forEach((line, i) => {
      // Lines that state a copyright holder: a copyright year, the copyright sign, or an "author" key.
      const states = /^\s*(copyright\s+(\(c\)\s*)?\d{4}|.*©\s*\d{4})/i.test(line) || /"author"\s*:\s*"/.test(line);
      if (states && !OWNER.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
  for (const rel of ['mcp-server/package.json', 'mcp-server/manifest.json', 'plugins/command-center/.claude-plugin/plugin.json']) {
    const author = JSON.parse(readFileSync(path.join(repo, rel), 'utf8')).author;
    assert.match(JSON.stringify(author), /nnthanh101@gmail\.com/, `${rel} names the owner`);
  }
});
