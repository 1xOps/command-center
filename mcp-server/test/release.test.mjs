// One version everywhere: npm, the MCP Registry, the plugin, the pinned plugin server and
// the marketplace must name the same release, or installs drift from what was approved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const { version, name } = read('../package.json');

test('every manifest names the package version', () => {
  const server = read('../server.json');
  assert.equal(server.version, version);
  assert.equal(server.packages[0].version, version);
  assert.equal(server.packages[0].identifier, name);
  assert.equal(read('../../plugins/command-center/.claude-plugin/plugin.json').version, version);
  assert.equal(read('../../.claude-plugin/marketplace.json').metadata.version, version);
});

test('the plugin pins the server version; never @latest', () => {
  const args = read('../../plugins/command-center/.mcp.json').mcpServers['command-center'].args;
  assert.ok(args.includes(`${name}@${version}`), args.join(' '));
});

test('every install line and team template pins the package version', () => {
  const pinned = new RegExp(`${name.replace('/', '\\/')}@([0-9][^"\\s\`]*)`, 'g');
  for (const rel of ['../../README.md', '../README.md', '../../templates/.mcp.json']) {
    const found = [...readFileSync(new URL(rel, import.meta.url), 'utf8').matchAll(pinned)].map((m) => m[1]);
    assert.ok(found.length > 0, `${rel} names no pinned version`);
    assert.deepEqual([...new Set(found)], [version], `${rel} pins ${[...new Set(found)]}`);
  }
  const { allowedDirectories } = read('../../templates/config.json');
  assert.ok(Array.isArray(allowedDirectories) && allowedDirectories.length > 0, 'templates/config.json sets allowedDirectories');
});
