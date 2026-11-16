import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discover, resolve, codexServers, attachToken, secretOf } from '../src/discover.mjs';
import { check, exitCode, accessFromRole } from '../src/check.mjs';

// A stand-in for the vendor CLIs: each setup answers like the real aws / gh would.
const fake = (answers) => async (cmd, args) => {
  const key = `${cmd} ${args.join(' ')}`;
  const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
  return hit ? { stdout: '', stderr: '', code: 0, missing: false, ...hit[1] } : { stdout: '', stderr: 'unexpected', code: 1, missing: false };
};
const later = new Date(Date.now() + 3600e3).toISOString();
const identity = (account, role) => ({ stdout: JSON.stringify({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/${role}/me` }) });
const gh = (state, scopes) => ({ stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state, login: 'dev', scopes }] } }), code: state === 'success' ? 0 : 1 });
const aws = (profile) => [{ name: 'billing', app: 'Claude Code', source: 'test', vendor: 'aws', profile }];
const github = [attachToken({ name: 'github', app: 'Claude Code', source: 'test', vendor: 'github', profile: null }, 'connector-token')];
const READ = { aws: { account: '111111111111', access: 'read' }, github: { access: 'read' } };

// The six setups of the side-by-side test. Native `claude mcp list` reports "Connected" for 1-5.
const setups = [
  ['1 missing AWS profile', aws('ops'), { 'aws sts': { code: 253, stderr: 'The config profile (ops) could not be found' } }, 'fail', /profile "ops" not found/],
  ['2 expired SSO session', aws('ops'), { 'aws sts': { code: 255, stderr: 'Error when retrieving token from sso: Token has expired and refresh failed' } }, 'fail', /expired/],
  ['3 wrong account', aws('ops'), { 'aws sts': identity('222222222222', 'AWSReservedSSO_ReadOnlyAccess_x') }, 'fail', /wrong account: expected …1111, signed in to …2222/],
  ['4 write scopes, read-only job', github, { 'gh auth': gh('success', 'read:org, repo, workflow') }, 'warn', /write access not needed.*repo, workflow/],
  ['5 revoked GitHub token', github, { 'gh auth': gh('error', '') }, 'fail', /invalid or revoked/],
  ['6 healthy control', aws('ops'), { 'aws sts': identity('111111111111', 'AWSReservedSSO_ReadOnlyAccess_x'), 'aws configure': { stdout: JSON.stringify({ Expiration: later }) } }, 'ok', /^$/],
];
for (const [name, connectors, answers, status, reason] of setups) {
  test(`setup ${name} → ${status}`, async () => {
    const [row] = await check(connectors, READ, fake(answers));
    assert.equal(row.status, status);
    assert.match(row.reason, reason);
  });
}

test('expiry within 15 minutes warns', async () => {
  const soon = new Date(Date.now() + 5 * 60e3).toISOString();
  const [row] = await check(aws('ops'), READ, fake({ 'aws sts': identity('111111111111', 'ReadOnly'), 'aws configure': { stdout: JSON.stringify({ Expiration: soon }) } }));
  assert.equal(row.status, 'warn');
});

test('access that cannot be classified is never ok for a read-only job', async () => {
  const [row] = await check(aws('ops'), READ, fake({ 'aws sts': identity('111111111111', 'team-role'), 'aws configure': { code: 1 } }));
  assert.equal(row.status, 'warn');
  assert.match(row.reason, /could not confirm read-only/);
});

test('missing vendor CLI fails with a plain reason', async () => {
  const [row] = await check(aws(null), {}, async () => ({ code: 1, stdout: '', stderr: '', missing: true }));
  assert.equal(row.status, 'fail');
  assert.equal(row.reason, 'aws CLI not installed');
  assert.equal(row.profile, '(default credentials)');
});

test('one probe per credential, shared by every connector using it', async () => {
  let calls = 0;
  const runner = async () => { calls++; return { code: 253, stdout: '', stderr: 'could not be found', missing: false }; };
  await check([...aws('ops'), ...aws('ops'), ...aws('ops')], {}, runner);
  assert.equal(calls, 1);
});

test('the full account number never appears in the result', async () => {
  const rows = await check(aws('ops'), READ, fake({ 'aws sts': identity('222222222222', 'ReadOnly') }));
  assert.doesNotMatch(JSON.stringify(rows), /222222222222/);
});

test('exit code: 2 on any failure, 1 on a warning, 0 otherwise', () => {
  assert.equal(exitCode([{ status: 'ok' }, { status: 'fail' }]), 2);
  assert.equal(exitCode([{ status: 'ok' }, { status: 'warn' }, { status: 'skip' }]), 1);
  assert.equal(exitCode([{ status: 'ok' }, { status: 'skip' }]), 0);
});

test('role names map to access levels', () => {
  assert.equal(accessFromRole('arn:aws:sts::1:assumed-role/AWSReservedSSO_ReadOnlyAccess_ab/me').access, 'read');
  assert.equal(accessFromRole('arn:aws:sts::1:assumed-role/AWSReservedSSO_AdministratorAccess_ab/me').access, 'write');
  assert.equal(accessFromRole('arn:aws:iam::1:root').access, 'write');
});

test('plugin settings never filled in resolve to the default credentials', () => {
  assert.equal(resolve('${user_config.aws_profile_billing}', {}), null);
  assert.equal(resolve('${AWS_PROFILE:-ops}', {}), 'ops');
  assert.equal(resolve('${AWS_PROFILE}', { AWS_PROFILE: 'billing' }), 'billing');
});

function fixtureHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cc-cwd-'));
  const plugin = path.join(home, 'plugins', 'finops');
  mkdirSync(plugin, { recursive: true });
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  mkdirSync(path.join(home, '.codex'));
  writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { billing: { command: 'uvx', args: ['awslabs.billing-cost-management-mcp-server==0.0.37'], env: { AWS_PROFILE: '${user_config.aws_profile_billing}' } } } }));
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'finops@m': true, 'off@m': false } }));
  writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'finops@m': [{ installPath: plugin }] } }));
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }));
  writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { notes: { command: 'npx', args: ['some-notes-server'] } } }));
  writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.aws]\ncommand = "uvx"\nargs = ["awslabs.aws-api-mcp-server"]\n\n[mcp_servers.aws.env]\nAWS_PROFILE = "ops"\n');
  return { home, cwd };
}

test('discovers connectors from Claude Code (user, folder, enabled plugins) and Codex', () => {
  const { home, cwd } = fixtureHome();
  const found = discover({ home, cwd, env: {} });
  assert.deepEqual(found.map((c) => [c.app, c.name, c.vendor, c.profile]), [
    ['Claude Code', 'github', 'github', null],
    ['Claude Code', 'notes', 'other', null],
    ['Claude Code', 'billing', 'aws', null],
    ['Codex', 'aws', 'aws', 'ops'],
  ]);
});

test('Codex TOML reader handles quoted names, arrays and env tables', () => {
  const s = codexServers('[mcp_servers."x"]\nurl = "https://e/mcp"\n[mcp_servers.y]\nargs = ["a", "b"]\n[mcp_servers.y.env]\nK = "v"\n[other]\nz = 1\n');
  assert.deepEqual(s, { x: { url: 'https://e/mcp' }, y: { args: ['a', 'b'], env: { K: 'v' } } });
});

test('CLI: --help exits 0; unknown command exits 64; no connectors exits 0', () => {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'command-center.mjs');
  assert.match(execFileSync(process.execPath, [bin, 'check', '--help'], { encoding: 'utf8' }), /Usage: command-center check/);
  assert.equal(spawnSync(process.execPath, [bin, 'nope']).status, 64);
  const empty = mkdtempSync(path.join(os.tmpdir(), 'cc-empty-'));
  const r = spawnSync(process.execPath, [bin, 'check', '--json'], { cwd: empty, env: { ...process.env, HOME: empty, USERPROFILE: empty, CODEX_HOME: empty }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).connectors, []);
});

test('real-machine cases: project-enabled plugin, plugin.json servers, --profile argument, unset variable', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cc-cwd-'));
  const plugin = path.join(home, 'plugins', 'tf');
  mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  mkdirSync(path.join(cwd, '.claude'));
  writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ mcpServers: { aws: { command: 'uvx', args: ['mcp-proxy-for-aws', 'https://aws-mcp.example/mcp', '--profile', '${AWS_OPERATIONS_PROFILE}'] } } }));
  writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tf@m': [{ installPath: plugin }] } }));
  writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tf@m': true } }));
  const found = discover({ home, cwd, env: {} });
  assert.deepEqual(found.map((c) => [c.name, c.vendor, c.profile, c.unset]), [['aws', 'aws', null, ['AWS_OPERATIONS_PROFILE']]]);
  const [row] = await check(found, {}, fake({ 'aws sts': { code: 253, stderr: 'Unable to locate credentials' } }));
  assert.equal(row.status, 'fail');
  assert.equal(row.reason, 'AWS_OPERATIONS_PROFILE not set, so the default credentials are used: no AWS credentials');
});

test('review fixes: account digits scrubbed, unresolved required account fails, write jobs judged, gh asked about the connector token', async () => {
  const leak = await check(aws('AdministratorAccess-123456789012'), {}, fake({ 'aws sts': { code: 254, stderr: 'User: arn:aws:sts::123456789012:assumed-role/x is not authorized' } }));
  assert.doesNotMatch(JSON.stringify(leak), /123456789012/);
  const ok = fake({ 'aws sts': identity('111111111111', 'ReadOnly') });
  assert.equal((await check(aws('ops'), { aws: { account: null } }, ok))[0].status, 'fail');
  assert.equal((await check(aws('ops'), { aws: { access: 'write' } }, ok))[0].status, 'fail');
  let seen;
  await check(github, {}, async (cmd, args, opts) => { seen = { args, token: opts?.env?.GH_TOKEN }; return gh('success', 'read:org'); });
  assert.deepEqual(seen, { args: ['auth', 'status', '--no-refresh', '--json', 'hosts'], token: 'connector-token' });
});

test('a GitHub connector whose token lives in the app is a warning, never ok', async () => {
  const [row] = await check([{ name: 'github', app: 'Claude Code', source: 'test', vendor: 'github', profile: null }], {}, fake({}));
  assert.equal(row.status, 'warn');
  assert.match(row.reason, /identity is unconfirmed/);
  assert.doesNotMatch(JSON.stringify(row), /connector-token/);
});

test('Codex inline env tables and single quotes; token from config is held but never output', () => {
  const s = codexServers("[mcp_servers.a]\nargs = ['awslabs.x']\nenv = { AWS_PROFILE = 'ops', REGION = \"x\" }\n");
  assert.deepEqual(s, { a: { args: ['awslabs.x'], env: { AWS_PROFILE: 'ops', REGION: 'x' } } });
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { command: 'github-mcp-server', env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GH_PAT}' } } } }));
  const [entry] = discover({ home, cwd: home, env: { GH_PAT: 'secret-value' } });
  assert.equal(secretOf(entry), 'secret-value');
  assert.doesNotMatch(JSON.stringify(entry), /secret-value/);
});

test('CLI: a malformed --require file is a failure (2), not a warning', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-bad-'));
  writeFileSync(path.join(dir, 'need.json'), '{not json');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'command-center.mjs');
  const r = spawnSync(process.execPath, [bin, 'check', '--require', path.join(dir, 'need.json')], { cwd: dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: dir }, encoding: 'utf8' });
  assert.equal(r.status, 2);
});
