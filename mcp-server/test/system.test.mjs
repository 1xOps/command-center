import assert from 'node:assert/strict';
import test from 'node:test';

const { listProcesses, linuxName } = await import('../dist/system.js');

test('list_processes finds this test process, with its parent and memory', async () => {
  const all = await listProcesses(undefined, 5000);
  assert.ok(all.total > 1, `total ${all.total}`);
  const me = all.processes.find((p) => p.pid === process.pid);
  assert.ok(me, 'this node process is listed');
  assert.equal(me.ppid, process.ppid);
  assert.match(me.name, /node/i);
  assert.ok(me.memoryKb > 1000, `memory ${me.memoryKb} KB`);
});

test('list_processes filters by name and applies the limit, largest memory first', async () => {
  const some = await listProcesses('NODE', 1);
  assert.equal(some.processes.length, 1);
  assert.ok(some.total >= 1);
  assert.match(some.processes[0].name, /node/i);
  const two = await listProcesses(undefined, 2);
  assert.ok(two.processes[0].memoryKb >= two.processes[1].memoryKb);
});

test('Linux names: comm unless the main thread was renamed; rewritten command lines keep comm', () => {
  assert.equal(linuxName('MainThread', '/usr/bin/node\0/app/dist/index.js\0'), 'node');
  assert.equal(linuxName('sshd', 'sshd: os@pts/0\0'), 'sshd');
  assert.equal(linuxName('chrome', '/opt/google/chrome/chrome --type=renderer --user-data-dir=/home/x/.cfg\0'), 'chrome');
  assert.equal(linuxName('postgres', 'postgres: checkpointer \0'), 'postgres');
  assert.equal(linuxName('kworker/0:1', ''), 'kworker/0:1');
  assert.equal(linuxName('systemd-journal', '/usr/lib/systemd/systemd-journald\0'), 'systemd-journald');
});
