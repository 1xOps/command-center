// `task mcp:verify` — "Can an engineer use Command Center today?" Times each step on this
// machine, prints the result and writes evidence JSON for the PR and the coordination log.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(root);
const WINDOWS = process.platform === 'win32';
const steps = [];

class Skip extends Error {}

// Every step ends as PASS, SKIP (named reason; not a pass) or FAIL (with the error).
async function step(name, fn) {
  const started = performance.now();
  const seconds = () => +((performance.now() - started) / 1000).toFixed(2);
  try {
    const detail = await fn(); // await first: the elapsed time must include the step
    steps.push({ name, ok: true, seconds: seconds(), detail });
  } catch (error) {
    const skipped = error instanceof Skip;
    steps.push({ name, ok: false, ...(skipped && { skipped }), seconds: seconds(), detail: String(error.message ?? error).slice(0, 2000) });
  }
}
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WINDOWS });
const npm = WINDOWS ? 'npm.cmd' : 'npm';

await step('build + tests (npm test)', () => {
  const out = sh(npm, ['test']);
  const pass = /ℹ pass (\d+)/.exec(out)?.[1];
  const fail = /ℹ fail (\d+)/.exec(out)?.[1];
  if (fail !== '0') throw new Error(`tests failed: ${fail}\n${out.slice(-1500)}`);
  return `${pass} passed, 0 failed`;
});

await step('server answers over stdio', async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'command-center-verify-'));
  try {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(root, 'dist', 'index.js')],
      env: { ...process.env, COMMAND_CENTER_CONFIG_DIR: configDir }, stderr: 'pipe',
    });
    let serverLog = '';
    transport.stderr?.on('data', (chunk) => { serverLog += chunk; });
    const client = new Client({ name: 'command-center-verify', version: '0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const run = await client.callTool({ name: 'start_process', arguments: { command: 'node --version', timeout_ms: 10_000 } });
      if (run.isError) throw new Error(run.content[0].text);
      return `${tools.length} tools; start_process ran node ${run.structuredContent.output.trim()}`;
    } catch (error) {
      throw new Error(`${error.message}\nserver log:\n${serverLog.slice(-1500)}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

await step('plugin and marketplace manifests (claude plugin validate)', () => {
  try { sh('claude', ['--version']); } catch { throw new Skip('Claude Code is not installed on this machine; manifests not validated'); }
  sh('claude', ['plugin', 'validate', '.'], repo);
  sh('claude', ['plugin', 'validate', 'plugins/command-center'], repo);
  return 'marketplace and plugin valid';
});

// A skipped step is not a pass: the total says INCOMPLETE and the exit code is non-zero.
const ok = steps.every((s) => s.ok);
const incomplete = steps.some((s) => s.skipped) && steps.every((s) => s.ok || s.skipped);
const verdict = ok ? 'PASS' : incomplete ? 'INCOMPLETE' : 'FAIL';
const total = +steps.reduce((n, s) => n + s.seconds, 0).toFixed(2);
for (const s of steps) console.log(`${s.ok ? 'PASS' : s.skipped ? 'SKIP' : 'FAIL'}  ${s.seconds.toFixed(2).padStart(7)} s  ${s.name}: ${s.detail}`);
console.log(`${verdict}  ${total.toFixed(2).padStart(7)} s  total on ${os.platform()} ${os.arch()}, Node ${process.versions.node}`);

const evidenceDir = path.join(repo, 'tmp', 'command-center', 'test-results');
mkdirSync(evidenceDir, { recursive: true });
const today = new Date().toLocaleDateString('en-CA'); // local date, YYYY-MM-DD
const file = path.join(evidenceDir, `mcp-verify-${os.platform()}-${today}.json`);
writeFileSync(file, `${JSON.stringify({ ok, verdict, totalSeconds: total, platform: os.platform(), arch: os.arch(), node: process.versions.node, at: new Date().toISOString(), steps }, null, 2)}\n`);
console.log(`evidence: ${path.relative(process.cwd(), file)}`);
process.exitCode = ok ? 0 : 1;
