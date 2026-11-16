#!/usr/bin/env node
// `task mcp:install-smoke` — "How long does an engineer take, on a clean machine, from nothing to a
// finished task with Command Center?" Installs a pinned client, clones the repo, runs the README install
// lines, counts the tools the session sees, runs a real task, checks the answer against a direct
// `npm test`, and (Claude) builds four files with the official document skills and reopens each one.
// Every step is timed with UTC stamps. Writes result.json; `--report` renders the evidence tables from
// result files, so PR and issue tables are rebuilt from data, never typed by hand. No dependencies.
//
//   node install-smoke.mjs --client claude|codex --out <dir> [--isolate] [--no-model] [--skip-docs]
//                          [--codex-auth <auth.json>] [--codex-bypass] [--timeout-min 15]
//   node install-smoke.mjs --report <result.json>...
//
// Secrets: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / OPENAI_API_KEY are read from the environment
// only, never printed, and redacted from every log and result file this script writes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---- Inputs: pins, prompts and file checks (change these, not the code below) ----------------------
const PINS = { claude: '@anthropic-ai/claude-code@2.1.325', codex: '@openai/codex@0.169.0' };
const REPO = { url: 'https://github.com/1xOps/command-center', branch: 'develop' };
const DOC_SKILLS = { marketplace: 'anthropics/skills', plugin: 'document-skills@anthropic-agent-skills' };
const SERVER = 'plugin:command-center:command-center'; // how Claude Code names the plugin's server
const CC_PREFIX = { claude: 'mcp__plugin_command-center_command-center__', codex: 'command-center' };
const RESULT_LINE = 'End your reply with one line exactly like: RESULT tests=<n> pass=<n> fail=<n> skipped=<n>';
const TASK = {
  claude: `Run this repo's tests and summarise failures. Use the command-center tools to run commands. ${RESULT_LINE}`,
  codex: `Run this repo's tests and summarise failures. Use the command-center MCP tools to run commands, not your own shell. ${RESULT_LINE}`,
};
const DOCS = [
  { skill: 'pdf', file: 'README.pdf', prompt: (o) => `Use the pdf skill. Build a one-page PDF summary of README.md in this folder and save it as ${o}. It must be exactly one page.` },
  { skill: 'xlsx', file: 'register.xlsx', prompt: (o) => `Use the xlsx skill. From docs/supply-chain/register.md take the table under "Packages that need a decision": its header row and its first 3 data rows, 4 rows in all. Put them on the first sheet of ${o}, one table cell per spreadsheet cell, the header in row 1, nothing else on the sheet.` },
  { skill: 'docx', file: 'SECURITY.docx', prompt: (o) => `Use the docx skill. Turn mcp-server/SECURITY.md into a Word document saved as ${o}. Keep each markdown heading as a Word heading (Heading 1, 2, 3 styles).` },
  { skill: 'pptx', file: 'install.pptx', prompt: (o) => `Use the pptx skill. Build a deck with exactly one slide, saved as ${o}, that shows the install lines from README.md: the two /plugin lines and the pinned npx lines.` },
];

// ---- Arguments ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (flag('--report')) { report(argv.filter((a) => a !== '--report')); process.exit(0); }
const client = opt('--client');
if (!['claude', 'codex'].includes(client)) die('--client claude|codex is required');
const OUT = path.resolve(opt('--out', `install-smoke-${client}`));
const NO_MODEL = flag('--no-model');
const DO_DOCS = client === 'claude' && !NO_MODEL && !flag('--skip-docs');
const TIMEOUT = Number(opt('--timeout-min', '15')) * 60_000;
const WIN = process.platform === 'win32';

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['logs', 'files', 'work']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'].map((k) => process.env[k]).filter((v) => v && v.length >= 8);
const redact = (s) => SECRETS.reduce((t, v) => t.split(v).join('[REDACTED]'), String(s));

// Clean-machine environment: own npm prefix always; with --isolate also own HOME and npm cache.
const env = { ...process.env, npm_config_prefix: path.join(OUT, 'npm-prefix'), npm_config_update_notifier: 'false', CI: process.env.CI ?? '1' };
if (flag('--isolate')) {
  const home = path.join(OUT, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, npm_config_cache: path.join(OUT, 'npm-cache'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') });
  if (WIN) Object.assign(env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
}
const HOME = env.HOME ?? os.homedir();
env.CODEX_HOME = path.join(WIN ? env.USERPROFILE ?? HOME : HOME, '.codex');
const binDir = WIN ? env.npm_config_prefix : path.join(env.npm_config_prefix, 'bin');
env.PATH = `${binDir}${path.delimiter}${env.PATH ?? env.Path ?? ''}`;
if (WIN) delete env.Path;

const result = { client, started: utc(), host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, isolated: flag('--isolate'), runner: process.env.RUNNER_OS ?? null }, pins: { client: PINS[client] }, noModel: NO_MODEL, steps: [], checks: {}, docs: [] };
const CLONE = path.join(OUT, 'work', 'command-center');

// ---- Process helpers ------------------------------------------------------------------------------------
function utc() { return new Date().toISOString(); }
function die(m) { console.error(m); process.exit(2); }
function log(name, text) { fs.appendFileSync(path.join(OUT, 'logs', `${name}.log`), redact(text)); }
function run(cmd, args, { cwd = OUT, input, timeout = 20 * 60_000, name, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { err += `\n[timeout after ${timeout / 1000}s]`; child.kill(); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (err += `\n[spawn error] ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (name) log(name, `$ ${cmd} ${args.join(' ')}\n[exit ${code}]\n--- stdout\n${out}\n--- stderr\n${err}\n`);
      resolve({ code, out, err });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
async function must(cmd, args, o) { const r = await run(cmd, args, o); if (r.code !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} exited ${r.code}: ${redact((r.err || r.out).slice(-600))}`); return r; }
async function step(name, fn) {
  const s = { name, start: utc() };
  const t0 = performance.now();
  try { s.detail = await fn(); s.ok = true; } catch (e) { s.ok = false; s.error = redact(String(e?.message ?? e)).slice(0, 1500); }
  s.end = utc(); s.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  result.steps.push(s);
  console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${String(s.seconds).padStart(7)} s  ${s.end}${s.ok ? '' : `  ${s.error.split('\n')[0]}`}`);
  return s;
}
function npmCli() {
  const dir = path.dirname(process.execPath);
  const c = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) die(`npm-cli.js not found next to ${process.execPath}`);
  return hit;
}
const NPM = npmCli();
result.host.npm = spawnSync(process.execPath, [NPM, '--version'], { env, encoding: 'utf8' }).stdout?.trim() ?? null;
const npm = (args, o) => must(process.execPath, [NPM, ...args], o);
const testCounts = (text) => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map((k) => [k, Number(new RegExp(`ℹ ${k} (\\d+)`).exec(text)?.[1] ?? NaN)]));
const resultLine = (text) => { const m = /RESULT tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)/.exec(text ?? ''); return m && { tests: +m[1], pass: +m[2], fail: +m[3], skipped: +m[4] }; };

// MCP handshake on a stdio command: initialize → initialized → tools/list. Used for Codex and as the
// Claude fallback; `shell` on Windows because the command is usually `npx` (a .cmd shim).
function mcpToolsList(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: WIN, windowsHide: true });
    let buf = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`tools/list timed out; stderr: ${err.slice(-400)}`)); }, 180_000);
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) { clearTimeout(timer); child.kill(); resolve(m.result.tools.map((t) => t.name)); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'install-smoke', version: '1' } } });
  });
}

// A headless Claude Code session driven over stream-json. It asks the session itself for its MCP status
// (control request `mcp_status`), waits until the plugin server is connected, then sends the prompt.
function claudeSession({ bin, cwd, prompt, allowed = [], disallowed = [], name }) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
    const child = spawn(bin, args, { cwd, env, windowsHide: true });
    const t0 = performance.now();
    const r = { tools: [], toolUses: [], skills: [], mcpConnectedSeconds: null, mcpStatus: null, result: null, model: null, stderr: '' };
    let buf = '', sent = false, polls = 0, done = false;
    const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch {} };
    const finish = () => { if (done) return; done = true; clearInterval(poll); clearTimeout(timer); try { child.stdin.end(); } catch {} setTimeout(() => child.kill(), 5000).unref(); };
    const timer = setTimeout(() => { r.timedOut = true; finish(); }, TIMEOUT);
    child.on('error', (e) => { r.stderr += `[spawn error] ${e.message}`; });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => (r.stderr += d));
    child.stdout.on('data', (d) => {
      buf += d; log(name, d.toString());
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'system' && e.subtype === 'init') r.model = e.model;
        if (e.type === 'control_response' && String(e.response?.request_id ?? '').startsWith('s')) {
          const list = e.response?.response?.mcpServers ?? [];
          const srv = list.find((s) => s.name === SERVER);
          r.mcpStatus = srv?.status ?? 'absent';
          if (srv?.status === 'connected' && !sent) {
            r.mcpConnectedSeconds = +((performance.now() - t0) / 1000).toFixed(1);
            r.tools = (srv.tools ?? []).map((t) => t.name);
            sent = true; clearInterval(poll);
            if (prompt) send({ type: 'user', message: { role: 'user', content: prompt } }); else finish();
          } else if (['failed', 'needs-auth', 'disabled'].includes(srv?.status) || polls > 180) { r.mcpFailed = true; finish(); }
        }
        if (e.type === 'assistant') for (const c of e.message?.content ?? []) if (c.type === 'tool_use') { r.toolUses.push(c.name); if (c.name === 'Skill') r.skills.push(c.input?.skill ?? c.input?.command ?? '?'); }
        if (e.type === 'result') { r.result = { subtype: e.subtype, isError: e.is_error, turns: e.num_turns, costUsd: e.total_cost_usd, durationMs: e.duration_ms, text: e.result }; finish(); }
      }
    });
    child.on('close', (code) => { r.exit = code; r.seconds = +((performance.now() - t0) / 1000).toFixed(1); log(name, `\n--- stderr\n${r.stderr}`); finish(); resolve(r); });
    send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
    const poll = setInterval(() => { polls++; send({ type: 'control_request', request_id: `s${polls}`, request: { subtype: 'mcp_status' } }); }, 1000);
  });
}

// ---- Steps ------------------------------------------------------------------------------------------
// The global root comes from the prefix, not `npm root -g`: npm masks UUID-shaped path segments as `***`
// in its output (measured 2026-11-16 with npm 11.19.0), which breaks paths under a UUID-named temp folder.
const pkgDir = async () => (WIN ? env.npm_config_prefix : path.join(env.npm_config_prefix, 'lib', 'node_modules'));
let clientCmd; // [command, ...leadingArgs]

await step(`install ${PINS[client]}`, async () => {
  await npm(['install', '-g', PINS[client], '--no-audit', '--no-fund'], { name: 'install-client' });
  const root = await pkgDir();
  clientCmd = client === 'claude' ? [path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')] : [process.execPath, path.join(root, '@openai', 'codex', 'bin', 'codex.js')];
  const v = await must(clientCmd[0], [...clientCmd.slice(1), '--version']);
  result.pins.clientVersion = v.out.trim();
  return v.out.trim();
});
const cli = (args, o) => must(clientCmd[0], [...clientCmd.slice(1), ...args], o);

await step('git clone --depth 1 -b develop', async () => {
  await must('git', ['clone', '--depth', '1', '-b', REPO.branch, REPO.url, CLONE], { name: 'clone' });
  const sha = (await must('git', ['rev-parse', '--short', 'HEAD'], { cwd: CLONE })).out.trim();
  result.cloneSha = sha;
  return `${REPO.url}@${sha}`;
});
const readme = fs.existsSync(path.join(CLONE, 'README.md')) ? fs.readFileSync(path.join(CLONE, 'README.md'), 'utf8') : '';

if (client === 'claude') {
  await step('README plugin commands', async () => {
    const mk = /^\/plugin marketplace add (\S+)$/m.exec(readme)?.[1];
    const pl = /^\/plugin install (\S+)$/m.exec(readme)?.[1];
    if (!mk || !pl) throw new Error('README has no /plugin marketplace add + /plugin install lines');
    await cli(['plugin', 'marketplace', 'add', mk], { name: 'plugin' });
    await cli(['plugin', 'install', pl], { name: 'plugin' });
    return `claude plugin marketplace add ${mk}; claude plugin install ${pl}`;
  });
  if (DO_DOCS) await step('document skills plugin', async () => {
    await cli(['plugin', 'marketplace', 'add', DOC_SKILLS.marketplace], { name: 'doc-skills' });
    await cli(['plugin', 'install', DOC_SKILLS.plugin], { name: 'doc-skills' });
    return `${DOC_SKILLS.marketplace} → ${DOC_SKILLS.plugin}`;
  });
  await step('server first start + tool count', async () => {
    const s = await claudeSession({ bin: clientCmd[0], cwd: CLONE, prompt: null, name: 'tools' });
    let method = 'the headless session itself: claude -p --input-format stream-json, control request mcp_status';
    let tools = s.tools;
    if (!tools.length) {
      method = `fallback MCP tools/list on the plugin command (session status: ${s.mcpStatus})`;
      const cfg = JSON.parse(fs.readFileSync(path.join(CLONE, 'plugins', 'command-center', '.mcp.json'), 'utf8')).mcpServers['command-center'];
      tools = await mcpToolsList(cfg.command, cfg.args, CLONE);
    }
    result.checks.tools = { count: tools.length, method, names: tools, connectedSeconds: s.mcpConnectedSeconds };
    if (tools.length !== 20) throw new Error(`${tools.length} tools, expected 20`);
    return `${tools.length} tools (${method}); connected after ${s.mcpConnectedSeconds ?? '?'} s`;
  });
} else {
  if (opt('--codex-auth')) {
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    fs.copyFileSync(opt('--codex-auth'), path.join(env.CODEX_HOME, 'auth.json'));
    fs.chmodSync(path.join(env.CODEX_HOME, 'auth.json'), 0o600);
    result.codexAuthRefreshBefore = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8')).last_refresh ?? null;
  }
  await step('README codex mcp add line', async () => {
    const m = /^codex mcp add (\S+) -- (npx) (.+?) \/path\/to\/project$/m.exec(readme);
    if (!m) throw new Error('README has no `codex mcp add … /path/to/project` line');
    await cli(['mcp', 'add', m[1], '--', m[2], ...m[3].split(' '), CLONE], { name: 'mcp-add' });
    return `codex mcp add ${m[1]} -- ${m[2]} ${m[3]} <clone>`;
  });
  await step('server first start + tool count', async () => {
    const j = JSON.parse((await cli(['mcp', 'get', 'command-center', '--json'], { name: 'tools' })).out);
    const t = j.transport ?? j;
    const tools = await mcpToolsList(t.command, t.args ?? [], CLONE);
    result.checks.tools = { count: tools.length, method: 'MCP tools/list on the command Codex stored (codex mcp get --json)', names: tools };
    if (tools.length !== 20) throw new Error(`${tools.length} tools, expected 20`);
    return `${tools.length} tools`;
  });
}

let agentCounts = null;
if (!NO_MODEL) {
  await step('task: run the tests, summarise', async () => {
    if (client === 'claude') {
      const s = await claudeSession({ bin: clientCmd[0], cwd: CLONE, prompt: TASK.claude, allowed: ['mcp__plugin_command-center_command-center', 'Read', 'Glob', 'Grep'], disallowed: ['Bash', 'Write', 'Edit'], name: 'task' });
      const cc = s.toolUses.filter((n) => n.startsWith(CC_PREFIX.claude)).map((n) => n.slice(CC_PREFIX.claude.length));
      agentCounts = resultLine(s.result?.text);
      result.checks.task = { model: s.model, toolsUsed: [...new Set(cc)], ccToolCalls: cc.length, otherToolCalls: s.toolUses.length - cc.length, result: s.result && { ...s.result, text: undefined }, reported: agentCounts, timedOut: !!s.timedOut, summary: s.result?.text?.slice(-1200) };
      if (!s.result || s.result.isError || s.result.subtype !== 'success') throw new Error(`session ended ${s.timedOut ? 'by timeout' : s.result?.subtype ?? `with exit ${s.exit}`}`);
      if (!cc.length) throw new Error('no Command Center tool was used');
    } else {
      // codex exec never prompts, so an unapproved MCP call is rejected ("requires approval, while the approval
      // policy is set to `never`", measured 2026-11-16 on 0.169.0). Approve this one server's tools, nothing else.
      const approve = ['-c', `mcp_servers.${CC_PREFIX.codex}.default_tools_approval_mode="approve"`];
      const sandbox = flag('--codex-bypass') ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', 'workspace-write', ...approve];
      const r = await run(clientCmd[0], [...clientCmd.slice(1), 'exec', '--json', '--skip-git-repo-check', ...sandbox, '-C', CLONE, '-'], { cwd: CLONE, input: TASK.codex, timeout: TIMEOUT, name: 'task' });
      const ev = r.out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const items = ev.filter((e) => e.type === 'item.completed').map((e) => e.item);
      const mcp = items.filter((i) => i.type === 'mcp_tool_call');
      const text = items.filter((i) => i.type === 'agent_message').map((i) => i.text).join('\n');
      const failed = ev.find((e) => e.type === 'turn.failed' || e.type === 'error');
      agentCounts = resultLine(text);
      result.checks.task = { toolsUsed: [...new Set(mcp.map((i) => `${i.server}.${i.tool}`))], ccToolCalls: mcp.filter((i) => i.server === CC_PREFIX.codex).length, okCcCalls: mcp.filter((i) => i.server === CC_PREFIX.codex && i.status === 'completed' && !i.error).length, failedCcCalls: mcp.filter((i) => i.status === 'failed' || i.error).length, approval: flag('--codex-bypass') ? 'bypass (container only)' : 'default_tools_approval_mode=approve for command-center', shellCalls: items.filter((i) => i.type === 'command_execution').length, usage: ev.findLast?.((e) => e.type === 'turn.completed')?.usage ?? null, reported: agentCounts, exit: r.code, summary: text.slice(-1200) };
      if (r.code !== 0 || failed) throw new Error(`codex exec exited ${r.code}${failed ? `: ${JSON.stringify(failed).slice(0, 300)}` : ''}`);
      if (!result.checks.task.okCcCalls) throw new Error(`no Command Center tool call succeeded (${result.checks.task.ccToolCalls} made)`);
    }
    return `${result.checks.task.ccToolCalls} Command Center tool calls; reported ${JSON.stringify(agentCounts)}`;
  });
}

// Not part of the timed path to "task done": the reference count the agent's answer is checked against.
await step('reference: direct npm test (same clone)', async () => {
  const cwd = path.join(CLONE, 'mcp-server');
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) await npm(['ci', '--no-audit', '--no-fund'], { cwd, name: 'direct-test' });
  const r = await run(process.execPath, [NPM, 'test'], { cwd, name: 'direct-test' });
  const c = testCounts(r.out);
  result.checks.direct = c;
  if (agentCounts) {
    result.checks.countsMatch = ['tests', 'pass', 'fail', 'skipped'].every((k) => agentCounts[k] === c[k]);
    if (!result.checks.countsMatch) throw new Error(`agent reported ${JSON.stringify(agentCounts)}, npm test says ${JSON.stringify(c)}`);
  }
  return `tests ${c.tests}, pass ${c.pass}, fail ${c.fail}, skipped ${c.skipped}`;
});

if (DO_DOCS) for (const d of DOCS) {
  const file = path.join(OUT, 'files', d.file);
  await step(`doc skill: ${d.skill} → ${d.file}`, async () => {
    const s = await claudeSession({ bin: clientCmd[0], cwd: CLONE, prompt: d.prompt(file), allowed: ['Skill', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__plugin_command-center_command-center'], name: `doc-${d.skill}` });
    const entry = { skill: d.skill, file: d.file, skillsInvoked: s.skills, result: s.result && { ...s.result, text: undefined }, timedOut: !!s.timedOut };
    result.docs.push(entry);
    if (!s.result || s.result.isError) throw new Error(`session ended ${s.timedOut ? 'by timeout' : s.result?.subtype ?? `with exit ${s.exit}`}`);
    if (!fs.existsSync(file)) throw new Error(`${d.file} was not written`);
    entry.check = inspect(d.skill, file);
    if (!entry.check.ok) throw new Error(entry.check.detail);
    return entry.check.detail;
  });
}

// ---- Result -----------------------------------------------------------------------------------------
result.finished = utc();
const first = result.steps[0];
const taskDone = result.steps.find((s) => s.name.startsWith('task:')) ?? result.steps.find((s) => s.name.startsWith('server first start'));
result.minutesToTaskDone = first && taskDone ? +((Date.parse(taskDone.end) - Date.parse(first.start)) / 60000).toFixed(2) : null;
result.measuredTo = NO_MODEL ? 'tool count (--no-model)' : 'task done';
result.ok = result.steps.every((s) => s.ok);
if (opt('--codex-auth')) result.codexAuthRefreshAfter = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8')).last_refresh ?? null;
fs.writeFileSync(path.join(OUT, 'result.json'), redact(JSON.stringify(result, null, 2)));
console.log(`\n${result.ok ? 'PASS' : 'FAIL'}  ${client} on ${process.platform}: ${result.minutesToTaskDone} min from start to ${result.measuredTo}; ${path.join(OUT, 'result.json')}`);
process.exit(result.ok ? 0 : 1);

// ---- File checks: reopen each built file without dependencies -----------------------------------------
function unzip(file) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const files = new Map();
  for (let p = b.readUInt32LE(e + 16), n = b.readUInt16LE(e + 10); n > 0; n--) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    const start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    const raw = b.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nl + xl + cl;
  }
  return files;
}
// A function declaration (hoisted): inspect() runs from the top-level code above, before a const here would exist.
function xmlText(x) { return [...String(x).matchAll(/<(?:a:|w:)?t(?:\s[^>]*)?>([^<]*)<\/(?:a:|w:)?t>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')); }
function inspect(kind, file) {
  try {
    if (kind === 'pdf') {
      const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
      const byInfo = info.status === 0 ? Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1]) : null;
      const byScan = (fs.readFileSync(file, 'latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
      const pages = byInfo ?? byScan;
      return { ok: pages === 1, pages, method: byInfo !== null ? 'pdfinfo' : 'page-object scan', detail: `${pages} page(s) (${byInfo !== null ? 'pdfinfo' : 'page-object scan'})` };
    }
    const z = unzip(file);
    if (kind === 'xlsx') {
      const sheet = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
      const xml = z.get(sheet).toString('utf8');
      const rows = (xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []).filter((r) => /<c\b/.test(r));
      const strings = xmlText(z.get('xl/sharedStrings.xml') ?? '').concat(xmlText(xml));
      const want = ['Package', '@modelcontextprotocol/sdk', 'zod', 'typescript'];
      const missing = want.filter((w) => !strings.some((s) => s.replace(/`/g, '').trim() === w));
      return { ok: rows.length === 4 && !missing.length, rows: rows.length, missing, detail: `${sheet}: ${rows.length} rows (header + ${rows.length - 1})${missing.length ? `; missing ${missing.join(', ')}` : '; header and first 3 packages present'}` };
    }
    if (kind === 'docx') {
      const xml = z.get('word/document.xml').toString('utf8');
      const headings = (xml.match(/<w:pStyle w:val="(?:Heading\d|Title)"/g) ?? []).length;
      const md = (fs.readFileSync(path.join(CLONE, 'mcp-server', 'SECURITY.md'), 'utf8').match(/^#{1,3} /gm) ?? []).length;
      const hasTitle = xmlText(xml).some((t) => t.includes('Security'));
      return { ok: headings >= 1 && hasTitle, headings, markdownHeadings: md, detail: `${headings} Word headings (SECURITY.md has ${md}); text includes "Security": ${hasTitle}` };
    }
    if (kind === 'pptx') {
      const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
      const text = slides.map((s) => xmlText(z.get(s)).join(' ')).join(' ');
      const hasInstall = text.includes('/plugin install') || text.includes('@1xops/command-center@');
      return { ok: slides.length === 1 && hasInstall, slides: slides.length, detail: `${slides.length} slide(s); install lines present: ${hasInstall}` };
    }
  } catch (e) { return { ok: false, detail: `cannot reopen ${path.basename(file)}: ${e.message}` }; }
  return { ok: false, detail: `no check for ${kind}` };
}

// ---- Report: evidence tables rendered from result files ----------------------------------------------
function report(files) {
  if (!files.length) die('--report <result.json>...');
  const rs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const osName = (r) => ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' })[r.host.platform] ?? r.host.platform;
  const min = (s) => (s ? `${(s.seconds / 60).toFixed(2)}${s.ok ? '' : ' ✖'}` : '—');
  const find = (r, p) => r.steps.find((s) => s.name.startsWith(p));
  console.log('| OS | Client | Install client | Clone | README install | Server start + tools | Task | **Minutes to task done** | UTC |');
  console.log('|---|---|--:|--:|--:|--:|--:|--:|---|');
  for (const r of rs) console.log(`| ${osName(r)}${r.host.isolated ? ' (fresh HOME)' : ''} | ${r.pins.clientVersion ?? r.pins.client} | ${min(r.steps[0])} | ${min(find(r, 'git clone'))} | ${min(find(r, 'README'))} | ${min(find(r, 'server first start'))} | ${min(find(r, 'task:'))} | **${r.minutesToTaskDone ?? '—'}**${r.measuredTo === 'task done' ? '' : ` (to ${r.measuredTo})`} | ${r.started} → ${(find(r, 'task:') ?? find(r, 'server first start'))?.end ?? r.finished} |`);
  console.log('\n| OS | Client | Tools (method) | Task: Command Center tools used | Agent counts = `npm test` | Doc files |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rs) {
    const t = r.checks.task;
    const d = r.checks.direct;
    const docs = r.docs.length ? r.docs.map((x) => `${x.skill}: ${x.check?.detail ?? 'not built'}`).join('<br>') : '—';
    console.log(`| ${osName(r)} | ${r.client} | ${r.checks.tools?.count ?? '—'} (${r.checks.tools?.method ?? 'not measured'}) | ${t ? `${t.ccToolCalls} calls: ${t.toolsUsed.join(', ')}` : '—'} | ${d ? `${r.checks.countsMatch === undefined ? 'not compared' : r.checks.countsMatch ? 'match' : 'MISMATCH'}: tests ${d.tests}, pass ${d.pass}, fail ${d.fail}, skipped ${d.skipped}` : '—'} | ${docs} |`);
  }
}
