#!/usr/bin/env node
// command-center check — before the AI starts a job, prove each connector is signed in to the right
// account with the right access. Exit 0 all ok · 1 a warning · 2 a failure.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { discover, resolve } from '../src/discover.mjs';
import { check, exitCode } from '../src/check.mjs';

const HELP = `Usage: command-center check [--json] [--brief] [--require <file>]

Finds the MCP connectors that Claude Code and Codex start on this machine, asks each vendor's own CLI
who they are signed in as (aws, gh), and reports account, access and expiry.

  --require <file>  what the job needs, e.g. {"aws":{"account":"\${AWS_ACCOUNT_ID}","access":"read"},
                    "github":{"access":"read"}}. Default: .command-center.json in this folder, if any.
  --json            machine-readable result
  --brief           print only problems (for a Claude Code SessionStart hook)

Exit code: 0 all ok, 1 warning, 2 failure.`;

const args = process.argv.slice(2);
if (args[0] !== 'check' || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(args[0] === 'check' || args.includes('--help') || args.includes('-h') ? 0 : 64);
}

const requireFile = args.includes('--require') ? args[args.indexOf('--require') + 1] : path.join(process.cwd(), '.command-center.json');
let need = {};
if (existsSync(requireFile)) {
  need = JSON.parse(readFileSync(requireFile, 'utf8'));
  if (need.aws?.account) need.aws.account = resolve(need.aws.account);
}

const rows = await check(discover(), need);
const code = exitCode(rows);

if (args.includes('--json')) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), exitCode: code, connectors: rows }, null, 2));
} else {
  const shown = args.includes('--brief') ? rows.filter((r) => r.status === 'warn' || r.status === 'fail') : rows;
  if (!rows.length) console.log('No MCP connectors found in Claude Code or Codex config.');
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: '—   ' };
  for (const r of shown) {
    const who = [r.identity, r.account && `account ${r.account}`, r.profile && `profile ${r.profile}`, r.access && `access ${r.access}`, r.expires && `expires ${r.expires}`].filter(Boolean).join(' · ');
    console.log(`${mark[r.status]} ${r.app} · ${r.name} (${r.source})${who ? `\n       ${who}` : ''}${r.reason ? `\n       ${r.reason}` : ''}`);
  }
  if (args.includes('--brief') && shown.length) console.log('command-center: fix the connectors above before starting work that needs them.');
}
process.exit(code);
