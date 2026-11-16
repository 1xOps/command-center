// Proves who each connector is signed in as, through the vendor's own CLI, and judges it against
// what the job needs. Only identity calls are made; no token or full account number is ever output.
import { execFile } from 'node:child_process';
import { secretOf } from './discover.mjs';

const SOON_MS = 15 * 60 * 1000;

export function run(cmd, args, { timeout = 20000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (error, stdout, stderr) => {
      const missing = error?.code === 'ENOENT' || /not recognized|command not found/i.test(stderr ?? '');
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', missing });
    });
  });
}

const mask = (account) => (account ? `…${String(account).slice(-4)}` : null);
// Profile names (`AdministratorAccess-123456789012`) and AWS errors (`arn:aws:sts::123456789012:…`) carry accounts.
export const scrub = (text) => (typeof text === 'string' ? text.replace(/\d{12}/g, (d) => `…${d.slice(-4)}`) : text);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function accessFromRole(arn) {
  const role = arn?.match(/:assumed-role\/([^/]+)\//)?.[1] ?? arn?.match(/:(user|root)/)?.[0]?.slice(1) ?? null;
  if (!role) return { role: null, access: 'unknown' };
  if (/readonly|viewonly|securityaudit|readaccess|viewer/i.test(role)) return { role, access: 'read' };
  if (/admin|poweruser|fullaccess|root/i.test(role)) return { role, access: 'write' };
  return { role, access: 'unknown' };
}

function awsReason(stderr, profile) {
  if (/could not be found/i.test(stderr)) return `AWS profile "${profile}" not found`;
  if (/expired|refresh failed|sso.*token/i.test(stderr)) return 'AWS sign-in expired (run aws sso login)';
  if (/nocredentials|unable to locate credentials|no credentials/i.test(stderr)) return 'no AWS credentials';
  return stderr.split('\n').find(Boolean)?.replace(/^aws: \[ERROR\]: /, '').slice(0, 120) || 'AWS identity call failed';
}

export async function probeAws(profile, runner = run) {
  const p = profile ? ['--profile', profile] : [];
  const id = await runner('aws', ['sts', 'get-caller-identity', '--output', 'json', ...p]);
  if (id.missing) return { ok: false, reason: 'aws CLI not installed' };
  if (id.code !== 0) return { ok: false, reason: awsReason(id.stderr, profile) };
  const who = parse(id.stdout);
  if (!who?.Account) return { ok: false, reason: 'AWS identity call returned no account' };
  // The process format holds secret keys: only Expiration is read, and the rest is dropped here.
  const expires = parse((await runner('aws', ['configure', 'export-credentials', '--format', 'process', ...p])).stdout)?.Expiration ?? null;
  const { role, access } = accessFromRole(who.Arn);
  return { ok: true, account: who.Account, identity: role, access, expires };
}

const WRITE_SCOPES = /^(repo|public_repo|workflow|delete_repo|write:.*|admin:.*)$/;

// `token` is the connector's own token, from its config; gh is only the tool that asks GitHub about it.
export async function probeGithub(token, runner = run) {
  if (!token) return { ok: false, unknown: true, reason: 'signs in through the app with its own token; command-center cannot see it, so the identity is unconfirmed' };
  const res = await runner('gh', ['auth', 'status', '--no-refresh', '--json', 'hosts'], { env: { GH_TOKEN: token } });
  if (res.missing) return { ok: false, reason: 'gh CLI not installed' };
  const host = parse(res.stdout)?.hosts?.['github.com']?.find((h) => h.active);
  if (!host || host.state !== 'success') return { ok: false, reason: "connector's GitHub token is invalid or revoked" };
  const scopes = (host.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const access = !scopes.length ? 'unknown' : scopes.some((s) => WRITE_SCOPES.test(s)) ? 'write' : 'read';
  return { ok: true, account: null, identity: host.login, access, scopes, expires: null };
}

export function verdict(probe, need = {}, now = Date.now()) {
  if (!probe.ok) return { status: probe.unknown ? 'warn' : 'fail', reason: probe.reason };
  if ('account' in need && !need.account) return { status: 'fail', reason: 'the job names a required account, but it resolved to nothing (is the variable set?)' };
  if (need.account && String(probe.account) !== String(need.account)) return { status: 'fail', reason: `wrong account: expected ${mask(need.account)}, signed in to ${mask(probe.account)}` };
  if (probe.expires && Date.parse(probe.expires) - now < SOON_MS) return { status: 'warn', reason: `sign-in expires ${probe.expires}` };
  if (need.access === 'read' && probe.access === 'write') return { status: 'warn', reason: `write access not needed for this job${probe.scopes ? ` (scopes: ${probe.scopes.join(', ')})` : ''}` };
  if (need.access === 'read' && probe.access === 'unknown') return { status: 'warn', reason: 'could not confirm read-only access' };
  if (need.access === 'write' && probe.access === 'read') return { status: 'fail', reason: 'the job needs write access; this connector is read-only' };
  if (need.access === 'write' && probe.access === 'unknown') return { status: 'warn', reason: 'could not confirm write access' };
  return { status: 'ok', reason: '' };
}

// One probe per distinct credential; every connector that uses it gets the same verdict.
export async function check(connectors, need = {}, runner = run) {
  const cache = new Map();
  const rows = [];
  for (const c of connectors) {
    if (c.vendor === 'other') { rows.push({ ...c, status: 'skip', reason: 'identity check not available for this connector yet' }); continue; }
    const token = c.vendor === 'github' ? secretOf(c) : null;
    const key = c.vendor === 'aws' ? `aws:${c.profile ?? ''}` : `github:${token ?? ''}`;
    if (!cache.has(key)) cache.set(key, c.vendor === 'aws' ? probeAws(c.profile, runner) : probeGithub(token, runner));
    const probe = await cache.get(key);
    const v = verdict(probe, need[c.vendor] ?? {});
    if (c.unset?.length && v.status !== 'ok') v.reason = `${c.unset.join(', ')} not set, so the default credentials are used: ${v.reason}`;
    rows.push({
      ...c,
      profile: c.vendor === 'aws' ? scrub(c.profile ?? '(default credentials)') : null,
      identity: scrub(probe.identity ?? null), account: mask(probe.account), access: probe.access ?? null,
      expires: probe.expires ?? null, status: v.status, reason: scrub(v.reason),
    });
  }
  return rows;
}

export const exitCode = (rows) => (rows.some((r) => r.status === 'fail') ? 2 : rows.some((r) => r.status === 'warn') ? 1 : 0);
