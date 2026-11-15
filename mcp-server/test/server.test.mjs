// End to end: the built server over stdio, driven by the official MCP SDK client.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scratch } from './helpers.mjs';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function connect(t, configDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, COMMAND_CENTER_CONFIG_DIR: configDir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'command-center-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('20 tools, each with a title and all four behaviour hints', async (t) => {
  const client = await connect(t, scratch(t, 'server-config'));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 20);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} sets ${hint}`);
    }
  }
  const info = client.getServerVersion();
  assert.equal(info?.name, 'command-center');
});

test('a read outside allowedDirectories fails with a message naming the setting', async (t) => {
  const configDir = scratch(t, 'server-config');
  const inside = scratch(t, 'server-in');
  const outside = scratch(t, 'server-out');
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ allowedDirectories: [inside] }));
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const client = await connect(t, configDir);
  const result = await client.callTool({ name: 'read_file', arguments: { path: path.join(outside, 'secret.txt') } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outside allowedDirectories/);
});

test('process tools return structured content that matches their output schema', async (t) => {
  const client = await connect(t, scratch(t, 'server-config'));
  const result = await client.callTool({ name: 'start_process', arguments: { command: 'echo ready', timeout_ms: 3000 } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.running, false);
  assert.match(result.structuredContent.output, /ready/);
});

test('set_config_value cannot widen allowedDirectories', async (t) => {
  const client = await connect(t, scratch(t, 'server-config'));
  const result = await client.callTool({ name: 'set_config_value', arguments: { key: 'allowedDirectories', value: ['/'] } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only be changed by a person/);
});

test('folders given at launch become allowedDirectories and get_config says so', async (t) => {
  const configDir = scratch(t, 'server-config');
  const picked = scratch(t, 'server-picked');
  const other = scratch(t, 'server-other');
  writeFileSync(path.join(other, 'x.txt'), 'x');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry, picked],
    env: { ...process.env, COMMAND_CENTER_CONFIG_DIR: configDir }, stderr: 'pipe',
  });
  const client = new Client({ name: 'command-center-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  const config = await client.callTool({ name: 'get_config', arguments: {} });
  assert.deepEqual(config.structuredContent.allowedDirectories, [picked]);
  assert.match(config.structuredContent.allowedDirectoriesFrom, /launch arguments/);
  const refused = await client.callTool({ name: 'read_file', arguments: { path: path.join(other, 'x.txt') } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /launch arguments/);
});
