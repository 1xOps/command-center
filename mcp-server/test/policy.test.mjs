import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolateConfig, scratch } from './helpers.mjs';

isolateConfig();
const { loadConfig, saveConfig, getConfig } = await import('../dist/config.js');
const { validatePath, checkCommand, expandHome } = await import('../dist/policy.js');
await loadConfig();

async function allow(...dirs) {
  await saveConfig({ ...getConfig(), allowedDirectories: dirs });
}

test('an empty allowedDirectories allows any path', async (t) => {
  const dir = scratch(t, 'policy');
  await allow();
  assert.equal(await validatePath(path.join(dir, 'a.txt')), path.join(dir, 'a.txt'));
});

test('a path outside allowedDirectories is refused with a message naming the setting and the file', async (t) => {
  const inside = scratch(t, 'policy-in');
  const outside = scratch(t, 'policy-out');
  await allow(inside);
  await assert.rejects(validatePath(path.join(outside, 'secret.txt')), /outside allowedDirectories.*config\.json/s);
  assert.equal(await validatePath(path.join(inside, 'ok.txt')), path.join(inside, 'ok.txt'));
});

test('a symlink inside an allowed folder cannot reach outside it, even for a file that does not exist yet', async (t) => {
  const inside = scratch(t, 'policy-in');
  const outside = scratch(t, 'policy-out');
  writeFileSync(path.join(outside, 'secret.txt'), 'x');
  // A junction needs no admin rights on Windows; elsewhere the type is ignored.
  symlinkSync(outside, path.join(inside, 'link'), 'junction');
  await allow(inside);
  await assert.rejects(validatePath(path.join(inside, 'link', 'secret.txt')), /outside allowedDirectories/);
  await assert.rejects(validatePath(path.join(inside, 'link', 'new', 'file.txt')), /outside allowedDirectories/);
});

test('a sibling folder whose name starts with the allowed name is outside', async (t) => {
  const base = scratch(t, 'policy');
  mkdirSync(path.join(base, 'proj'));
  mkdirSync(path.join(base, 'proj-other'));
  await allow(path.join(base, 'proj'));
  await assert.rejects(validatePath(path.join(base, 'proj-other', 'x')), /outside allowedDirectories/);
});

test('~ expands to the home folder, and a NUL byte is refused', async () => {
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'));
  await allow();
  await assert.rejects(validatePath('a\0b'), /NUL/);
});

test('blocked programs are refused wherever they start a simple command', async () => {
  await allow();
  for (const line of [
    'sudo rm -rf /', 'ls; sudo id', 'true && sudo id', 'false || sudo id', 'echo hi | sudo tee x', 'echo $(sudo id)',
    'echo `sudo id`', 'FOO=1 sudo id', 'env -i sudo id', 'timeout 5 sudo id', 'nice -n 10 sudo id', '/usr/bin/sudo id',
    '(sudo id)', 'ls\nsudo id', 'exec sudo id', 'bash -c "sudo id"', 'sh -c \'sudo id\'',
    'diskpart', 'DISKPART', 'C:\\Windows\\System32\\DISKPART.EXE /s x', 'cmd /c diskpart', 'cmd.exe /d /s /c "reg add x"',
    'powershell -NoProfile -Command "bcdedit /set x"', 'Start-Process takeown', '& "C:\\Windows\\System32\\net.exe" user',
  ]) {
    assert.throws(() => checkCommand(line), /blockedCommands/, line);
  }
});

test('eval and Invoke-Expression are refused because the check cannot read their text', () => {
  assert.throws(() => checkCommand('eval "$CMD"'), /eval/);
  assert.throws(() => checkCommand('Invoke-Expression $cmd'), /invoke-expression/);
  assert.throws(() => checkCommand('iex (Get-Content x)'), /iex/);
});

test('ordinary commands, and blocked words used as arguments, are allowed', () => {
  for (const line of ['npm test', 'echo sudo', 'grep -r mount src', 'source .venv/bin/activate && pytest', 'git log --oneline | head',
    'Get-ChildItem -Recurse', 'bash scripts/build.sh', 'cmd /c dir', 'powershell -Command "Get-Process"']) {
    assert.doesNotThrow(() => checkCommand(line), line);
  }
});

// Regression tests for the 2026-11-16 independent review.
test('a dangling symlink inside an allowed folder cannot create a file outside it', async (t) => {
  const inside = scratch(t, 'policy-in');
  const outside = scratch(t, 'policy-out');
  symlinkSync(path.join(outside, 'created-by-link.txt'), path.join(inside, 'dangling'));
  await allow(inside);
  await assert.rejects(validatePath(path.join(inside, 'dangling')), /outside allowedDirectories/);
});

test('the settings folder is refused even with no folder limit', async () => {
  await allow();
  const { configPath } = await import('../dist/config.js');
  await assert.rejects(validatePath(configPath()), /settings folder/);
});

test('a folder whose name starts with two dots is inside, not a parent', async (t) => {
  const base = scratch(t, 'policy');
  mkdirSync(path.join(base, '..cache'));
  await allow(base);
  assert.equal(await validatePath(path.join(base, '..cache', 'x')), path.join(base, '..cache', 'x'));
});

test('shell keywords, wrapper flags and other shells do not hide a blocked program', async () => {
  await allow();
  for (const line of ['if true; then sudo ls; fi', '{ sudo ls; }', '! sudo ls', 'timeout -s KILL 5 sudo ls', 'exec -a x sudo ls', 'tcsh -c "sudo ls"', 'while true; do sudo ls; done']) {
    assert.throws(() => checkCommand(line), /blockedCommands/, line);
  }
});

test('checkCommand reports the programs it saw, including shells started indirectly', () => {
  assert.ok(checkCommand('exec bash').includes('bash'));
  assert.ok(checkCommand('true; sh').includes('sh'));
  assert.ok(checkCommand('env bash').includes('bash'));
});

test('ssh: options and host are skipped; only the remote command is checked', () => {
  for (const ok of ['ssh net', 'ssh sc', 'ssh -i ~/.ssh/net host', 'ssh -F ~/.ssh/reg host', 'ssh -l su host',
    'ssh -J bastion app uptime', 'ssh host cat /etc/passwd', 'ssh host kubectl get sc', 'ssh host tail /var/log/reboot',
    'ssh -o BatchMode=yes -o ConnectTimeout=10 user@host', 'ssh -L 8080:localhost:80 host', 'mosh host']) {
    assert.doesNotThrow(() => checkCommand(ok), ok);
  }
  for (const bad of ['ssh admin@host sudo reboot', 'ssh -p 22 host sudo id', 'ssh host "sudo id"', 'ssh -t host env sudo id', 'mosh host -- sudo id']) {
    assert.throws(() => checkCommand(bad), /blockedCommands/, bad);
  }
});
