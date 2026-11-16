// Commands are `node -e` one-liners so the same test runs in sh/zsh (macOS, Linux) and
// PowerShell (Windows): double quotes outside, single quotes inside, no $ or backticks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolateConfig, scratch } from './helpers.mjs';

isolateConfig();
const { loadConfig, saveConfig, getConfig } = await import('../dist/config.js');
const proc = await import('../dist/processes.js');
await loadConfig();
const WINDOWS = process.platform === 'win32';
await saveConfig({ ...getConfig(), defaultShell: WINDOWS ? 'powershell.exe' : '/bin/sh' });

const ECHO_STDIN = `node -e "process.stdin.pipe(process.stdout)"`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a short command returns its output and exit code', async () => {
  const result = await proc.startProcess(`node -e "console.log('hello'); process.exit(3)"`, 10_000);
  assert.match(result.output, /hello/);
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 3);
});

test('a session keeps running and answers input', async () => {
  const started = await proc.startProcess(ECHO_STDIN, 1000);
  assert.equal(started.running, true);
  const reply = await proc.interact(started.pid, 'ping', 5000);
  assert.match(reply.output, /ping/);
  await proc.terminate(started.pid);
});

test('read_process_output returns only output not read before', async () => {
  const started = await proc.startProcess(
    `node -e "console.log('first'); setTimeout(() => console.log('second'), 1500); setTimeout(() => {}, 60000)"`, 1000);
  assert.match(started.output, /first/);
  const later = await proc.readOutput(started.pid, 5000);
  assert.match(later.output, /second/);
  assert.doesNotMatch(later.output, /first/);
  await proc.terminate(started.pid);
});

test('force_terminate stops the whole process tree, including children', async () => {
  const started = await proc.startProcess(
    `node -e "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log('child ' + c.pid); setTimeout(() => {}, 60000)"`,
    3000);
  const child = Number(/child (\d+)/.exec(started.output)?.[1]);
  assert.ok(child > 0 && alive(child), `child pid from: ${started.output}`);
  const stopped = await proc.terminate(started.pid);
  assert.equal(stopped.running, false);
  for (let i = 0; i < 20 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(child), false);
  assert.equal(proc.listSessions().some((s) => s.pid === started.pid), false);
});

test('blocked commands are refused at start and inside an interactive shell', async () => {
  await assert.rejects(proc.startProcess('sudo id', 1000), /blockedCommands/);
  await assert.rejects(proc.startProcess('diskpart', 1000), /blockedCommands/);
  const shell = await proc.startProcess(WINDOWS ? 'cmd' : 'sh', 1000);
  await assert.rejects(proc.interact(shell.pid, 'sudo id', 1000), /blockedCommands/);
  await proc.terminate(shell.pid);
});

test('input to a non-shell program is not checked as a command line', async () => {
  const started = await proc.startProcess(ECHO_STDIN, 1000);
  const reply = await proc.interact(started.pid, 'dd = 1', 5000);
  assert.match(reply.output, /dd = 1/);
  await proc.terminate(started.pid);
});

test('the working directory must be allowed', async (t) => {
  const inside = scratch(t, 'proc-in');
  const outside = scratch(t, 'proc-out');
  await saveConfig({ ...getConfig(), allowedDirectories: [inside] });
  await assert.rejects(proc.startProcess('node -v', 1000, outside), /outside allowedDirectories/);
  const result = await proc.startProcess(`node -e "console.log(process.cwd())"`, 10_000, inside);
  assert.ok(result.output.includes(path.basename(inside)), result.output);
  await saveConfig({ ...getConfig(), allowedDirectories: [] });
});

test('an unknown pid gives a clear error', async () => {
  await assert.rejects(proc.readOutput(999999, 0), /no session with pid 999999/);
});

test('each shell gets its own way of running one command line', () => {
  assert.deepEqual(proc.shellArgs('/bin/zsh', 'ls'), ['-c', 'ls']);
  const ps = proc.shellArgs('powershell.exe', 'ls');
  assert.deepEqual(ps.slice(0, 3), ['-NoLogo', '-NoProfile', '-Command']);
  assert.match(ps[3], /^ls\n.*exit \$LASTEXITCODE/, 'the command, then the line that keeps its exit code');
  assert.deepEqual(proc.shellArgs('C:\\Windows\\System32\\cmd.exe', 'dir'), ['/d', '/s', '/c', '"dir"']);
});

test('input to a shell started indirectly is checked too', async () => {
  const started = await proc.startProcess(WINDOWS ? 'cmd' : 'exec sh', 1000);
  await assert.rejects(proc.interact(started.pid, 'sudo id', 1000), /blockedCommands/);
  await proc.terminate(started.pid);
});

test('ssh: a remote command after the host is checked, and typed input is checked too', { skip: WINDOWS && 'POSIX fake ssh' }, async (t) => {
  await assert.rejects(proc.startProcess('ssh admin@host sudo reboot', 1000), /blockedCommands/);
  // A stand-in `ssh` that echoes its input, so no network is needed.
  const dir = scratch(t, 'fake-ssh');
  const fake = path.join(dir, 'ssh');
  writeFileSync(fake, '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  const started = await proc.startProcess(`${fake} host`, 1000);
  await assert.rejects(proc.interact(started.pid, 'sudo reboot', 1000), /blockedCommands/);
  const reply = await proc.interact(started.pid, 'uptime', 5000);
  assert.match(reply.output, /uptime/);
  await proc.terminate(started.pid);
});
