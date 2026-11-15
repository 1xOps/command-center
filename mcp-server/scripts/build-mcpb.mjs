// Builds command-center-<version>.mcpb for Claude Desktop (macOS, Windows).
// Stages the built server with production dependencies only in a private temp folder, then
// packs it with Anthropic's official bundle tool, pinned and run through npx so its own
// dependencies never enter this project's install.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCPB = '@anthropic-ai/mcpb@2.1.2';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, `command-center-${version}.mcpb`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

statSync(path.join(root, 'dist', 'index.js')); // fails clearly when `npm run build` has not run
const stage = mkdtempSync(path.join(os.tmpdir(), 'command-center-mcpb-'));
try {
  for (const item of ['dist', 'package.json', 'package-lock.json', 'manifest.json', 'icon.png', 'LICENSE']) {
    cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
  }
  run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  run(npx, ['-y', MCPB, 'validate', 'manifest.json'], stage);
  run(npx, ['-y', MCPB, 'pack', stage, out], stage);
  console.log(`built ${path.relative(process.cwd(), out)} (${statSync(out).size} bytes)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
