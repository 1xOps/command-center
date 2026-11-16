import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolateConfig, scratch } from './helpers.mjs';

isolateConfig();
const { loadConfig, saveConfig, getConfig } = await import('../dist/config.js');
const files = await import('../dist/files.js');
await loadConfig();

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('read_file returns a line window, and a negative offset reads the tail', async (t) => {
  const file = path.join(scratch(t, 'files'), 'log.txt');
  writeFileSync(file, numbered(10));
  const head = await files.readTextOrImage(file, 0, 3);
  assert.equal(head.text, 'line 1\nline 2\nline 3');
  assert.deepEqual([head.fromLine, head.toLine, head.totalLines], [1, 3, 10]);
  const tail = await files.readTextOrImage(file, -2);
  assert.equal(tail.text, 'line 9\nline 10');
});

test('read_file caps at fileReadLineLimit', async (t) => {
  const file = path.join(scratch(t, 'files'), 'big.txt');
  writeFileSync(file, numbered(50));
  await saveConfig({ ...getConfig(), fileReadLineLimit: 20 });
  const result = await files.readTextOrImage(file, 0, 40);
  assert.equal(result.toLine, 20);
  await saveConfig({ ...getConfig(), fileReadLineLimit: 1000 });
});

test('binary files are refused and images come back as base64', async (t) => {
  const dir = scratch(t, 'files');
  writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  await assert.rejects(files.readTextOrImage(path.join(dir, 'blob.bin')), /binary/);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(path.join(dir, 'pic.png'), png);
  const image = await files.readTextOrImage(path.join(dir, 'pic.png'));
  assert.equal(image.kind, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').toString('hex'), png.toString('hex'));
});

test('write_file refuses content over fileWriteLineLimit and appends in chunks', async (t) => {
  const file = path.join(scratch(t, 'files'), 'sub', 'out.txt');
  const limit = getConfig().fileWriteLineLimit;
  await assert.rejects(files.writeText(file, numbered(limit + 5), 'rewrite'), /fileWriteLineLimit/);
  await files.writeText(file, 'a\n', 'rewrite');
  await files.writeText(file, 'b\n', 'append');
  assert.equal(readFileSync(file, 'utf8'), 'a\nb\n');
});

test('edit_block replaces an exact unique match', async (t) => {
  const file = path.join(scratch(t, 'files'), 'code.ts');
  writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
  await files.editBlock(file, 'const b = 2;', 'const b = 3;');
  assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 3;\n');
});

test('edit_block changes nothing when the count differs from expected_replacements', async (t) => {
  const file = path.join(scratch(t, 'files'), 'code.ts');
  writeFileSync(file, 'x\nx\n');
  await assert.rejects(files.editBlock(file, 'x', 'y'), /occurs 2 times/);
  assert.equal(readFileSync(file, 'utf8'), 'x\nx\n');
  await files.editBlock(file, 'x', 'y', 2);
  assert.equal(readFileSync(file, 'utf8'), 'y\ny\n');
});

test('edit_block with no exact match changes nothing and shows the closest passage', async (t) => {
  const file = path.join(scratch(t, 'files'), 'code.ts');
  const original = 'function add(a, b) {\n  return a + b;\n}\n';
  writeFileSync(file, original);
  await assert.rejects(files.editBlock(file, 'function add(a,b) {\n  return a+b;', 'x'), /lines 1-2 \(\d+% similar\):\nfunction add\(a, b\) \{/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('levenshtein distance', () => {
  assert.equal(files.levenshtein('kitten', 'sitting'), 3);
  assert.equal(files.levenshtein('', 'abc'), 3);
  assert.equal(files.levenshtein('same', 'same'), 0);
});

test('list_directory respects depth and marks entry types', async (t) => {
  const dir = scratch(t, 'files');
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(path.join(dir, 'a', 'b', 'deep.txt'), '');
  writeFileSync(path.join(dir, 'top.txt'), '');
  const shallow = await files.listDirectory(dir, 1);
  assert.deepEqual(shallow.entries, ['[DIR] a/', '[FILE] top.txt']);
  const deep = await files.listDirectory(dir, 3);
  assert.ok(deep.entries.includes(`[FILE] ${path.join('a', 'b', 'deep.txt')}`));
});

test('move_file refuses an existing destination; create_directory and get_file_info work', async (t) => {
  const dir = scratch(t, 'files');
  writeFileSync(path.join(dir, 'one.txt'), 'one\ntwo\n');
  writeFileSync(path.join(dir, 'two.txt'), 'two');
  await assert.rejects(files.moveFile(path.join(dir, 'one.txt'), path.join(dir, 'two.txt')), /already exists/);
  await files.moveFile(path.join(dir, 'one.txt'), path.join(dir, 'three.txt'));
  assert.ok(existsSync(path.join(dir, 'three.txt')));
  await files.createDirectory(path.join(dir, 'x', 'y'));
  const info = await files.fileInfo(path.join(dir, 'three.txt'));
  assert.equal(info.type, 'file');
  assert.equal(info.lines, 3);
});

test('list_directory fails for a missing folder or a file instead of listing nothing', async (t) => {
  const dir = scratch(t, 'files');
  writeFileSync(path.join(dir, 'a.txt'), '');
  await assert.rejects(files.listDirectory(path.join(dir, 'missing'), 1), /cannot list/);
  await assert.rejects(files.listDirectory(path.join(dir, 'a.txt'), 1), /it is a file/);
});

test('move_file moves a symlink itself, not its target, and allows a case-only rename', async (t) => {
  const dir = scratch(t, 'files');
  writeFileSync(path.join(dir, 'target.txt'), 'data');
  const { symlinkSync, lstatSync } = await import('node:fs');
  symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link'));
  await files.moveFile(path.join(dir, 'link'), path.join(dir, 'link2'));
  assert.ok(lstatSync(path.join(dir, 'link2')).isSymbolicLink());
  assert.ok(existsSync(path.join(dir, 'target.txt')), 'the target stays where it was');
  writeFileSync(path.join(dir, 'Readme.md'), 'x');
  await files.moveFile(path.join(dir, 'Readme.md'), path.join(dir, 'README.md'));
  assert.ok(existsSync(path.join(dir, 'README.md')));
});

test('move_file expands ~ like every other file tool', async (t) => {
  const home = scratch(t, 'home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => Object.assign(process.env, saved));
  writeFileSync(path.join(home, 'a.txt'), 'x');
  const moved = await files.moveFile('~/a.txt', '~/b.txt');
  assert.equal(moved.to, path.join(home, 'b.txt'));
  assert.ok(existsSync(path.join(home, 'b.txt')) && !existsSync(path.join(home, 'a.txt')));
});
