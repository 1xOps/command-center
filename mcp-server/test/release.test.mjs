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
