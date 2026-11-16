// `task evidence`: runs Claude Code's own connector status and `command-center check` on this machine at
// the same moment and writes both to docs/evidence/<os>-<UTC date>.json. Account numbers stay masked.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scrub } from '../src/check.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const at = new Date().toISOString();
const native = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32' });
if (native.error) throw new Error(`claude mcp list did not run: ${native.error.message}`);
const ours = spawnSync(process.execPath, [path.join(root, 'cli', 'bin', 'command-center.mjs'), 'check', '--json'], { encoding: 'utf8' });
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const result = {
  at, commit, os: process.platform, folder: path.basename(process.cwd()),
  native: { command: 'claude mcp list', exitCode: native.status, lines: (native.stdout ?? '').split('\n').filter((l) => /aws|github/i.test(l)).map((l) => scrub(l.replaceAll(os.homedir(), '~'))) },
  commandCenter: { command: 'command-center check --json', ...JSON.parse(ours.stdout) },
};
const dir = path.join(root, 'docs', 'evidence');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${process.platform}-${at.slice(0, 10)}.json`);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${path.relative(root, file)}: native ${result.native.lines.length} AWS/GitHub lines, command-center exit ${result.commandCenter.exitCode}`);
