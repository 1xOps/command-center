import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { isolateConfig } from './helpers.mjs';

const dir = isolateConfig();
const config = await import('../dist/config.js');

test('a first start writes the defaults to a private file', async () => {
  const loaded = await config.loadConfig();
  assert.deepEqual(loaded.allowedDirectories, []);
  assert.ok(loaded.blockedCommands.includes('sudo'));
  // POSIX permission bits; Windows uses ACLs, where the user profile folder is private already.
  if (process.platform !== 'win32') {
    assert.equal(statSync(config.configPath()).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
});

test('an invalid config file stops the server and is left untouched (fail closed)', async () => {
  // A locked-down file with one typo must never fall back to "no folder limit".
  const broken = '{ "allowedDirectories": ["/srv/project"], }';
  writeFileSync(config.configPath(), broken);
  await assert.rejects(config.loadConfig(), /not valid, so Command Center will not start/);
  assert.equal(readFileSync(config.configPath(), 'utf8'), broken);
});

test('a config value of the wrong type is invalid too', async () => {
  writeFileSync(config.configPath(), JSON.stringify({ allowedDirectories: 'not-a-list' }));
  await assert.rejects(config.loadConfig(), /not valid/);
  rmSync(config.configPath());
});

test('agents can change limits but not the security settings', async () => {
  await config.loadConfig();
  await config.setConfigValue('fileReadLineLimit', 200);
  assert.equal(JSON.parse(readFileSync(config.configPath(), 'utf8')).fileReadLineLimit, 200);
  for (const key of ['allowedDirectories', 'blockedCommands', 'defaultShell']) {
    await assert.rejects(config.setConfigValue(key, []), /only be changed by a person/, key);
  }
  await assert.rejects(config.setConfigValue('nope', 1), /unknown setting/);
  await assert.rejects(config.setConfigValue('fileReadLineLimit', -1));
});

test('saving leaves no temporary files behind', async () => {
  await config.saveConfig(config.getConfig());
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});
