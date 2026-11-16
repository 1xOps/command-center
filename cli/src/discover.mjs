// Finds the MCP connectors each AI app on this machine will start, from the apps' own config files.
// Read-only: nothing here writes a file or starts a server.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// A connector's own token stays here, keyed by its entry, so it can be probed but is never output.
const secrets = new WeakMap();
export const secretOf = (entry) => secrets.get(entry) ?? null;
export const attachToken = (entry, token) => (token && secrets.set(entry, token), entry);

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

// `${VAR}` and `${VAR:-default}` resolve from the environment, as the apps do. A plugin setting
// (`${user_config.x}`) that the person never filled in resolves to empty, so the server falls back
// to the vendor's default credentials; we report that instead of guessing.
export function resolve(value, env = process.env) {
  if (typeof value !== 'string') return value ?? null;
  let unresolved = false;
  const out = value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, name, dflt) => {
    if (name.startsWith('user_config.')) { unresolved = true; return ''; }
    return env[name] ?? dflt ?? '';
  });
  return out === '' && unresolved ? null : out || null;
}

// Names of `${VAR}` references with no value and no default: the app starts the server without them.
export function missingVars(value, env = process.env) {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\$\{([^}:]+)(:-[^}]*)?\}/g)].filter(([, n, d]) => !d && (n.startsWith('user_config.') || env[n] === undefined)).map(([, n]) => n);
}

function vendorOf(name, server) {
  const text = [name, server.command, ...(server.args ?? []), server.url ?? ''].join(' ').toLowerCase();
  if (/awslabs\.|aws-api-mcp|mcp-proxy-for-aws|amazon/.test(text) || server.env?.AWS_PROFILE !== undefined) return 'aws';
  if (/githubcopilot\.com\/mcp|github-mcp-server/.test(text)) return 'github';
  return 'other';
}

function entries(servers, app, source, env) {
  return Object.entries(servers ?? {}).map(([name, server]) => {
    const vendor = vendorOf(name, server);
    // The profile comes from the server's env, or from a `--profile X` argument (mcp-proxy-for-aws).
    const args = server.args ?? [];
    const raw = server.env?.AWS_PROFILE ?? (args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined);
    const profile = vendor === 'aws' ? resolve(raw, env) : null;
    const unset = vendor === 'aws' ? missingVars(raw, env) : [];
    const entry = { name, app, source, vendor, profile, unset, url: server.url ?? null };
    if (vendor === 'github') {
      const raw = server.env?.GITHUB_PERSONAL_ACCESS_TOKEN ?? server.env?.GITHUB_TOKEN ?? server.headers?.Authorization?.replace(/^Bearer\s+/i, '');
      const token = resolve(raw, env);
      attachToken(entry, token);
    }
    return entry;
  });
}

// Minimal reader for the parts of Codex's config.toml we need: [mcp_servers.NAME] and its .env table.
export function codexServers(toml) {
  const servers = {};
  let current = null;
  let inEnv = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const table = line.match(/^\[mcp_servers\.("?)([^".\]]+)\1(\.env)?\]$/);
    if (table) { current = (servers[table[2]] ??= {}); inEnv = Boolean(table[3]); continue; }
    if (line.startsWith('[')) { current = null; continue; }
    const kv = current && line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const str = (v) => v.trim().replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b);
    let value;
    if (kv[2].startsWith('[')) value = [...kv[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    else if (kv[2].startsWith('{')) value = Object.fromEntries([...kv[2].matchAll(/([A-Za-z_][\w-]*)\s*=\s*("[^"]*"|'[^']*')/g)].map((m) => [m[1], str(m[2])]));
    else value = str(kv[2]);
    if (inEnv) (current.env ??= {})[kv[1]] = value;
    else current[kv[1]] = value;
  }
  return servers;
}

export function discover({ home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const found = [];
  const claudeJson = readJson(path.join(home, '.claude.json'));
  found.push(...entries(claudeJson?.mcpServers, 'Claude Code', '~/.claude.json', env));
  const folder = claudeJson?.projects?.[cwd] ?? claudeJson?.projects?.[cwd.replaceAll('\\', '/')];
  found.push(...entries(folder?.mcpServers, 'Claude Code', '~/.claude.json (this folder)', env));
  found.push(...entries(readJson(path.join(cwd, '.mcp.json'))?.mcpServers, 'Claude Code', '.mcp.json', env));

  // Plugins: only those switched on. Later files win, as in Claude Code: user settings, then this folder's shared and local settings.
  const enabled = Object.assign({}, ...[path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]
    .map((f) => readJson(f)?.enabledPlugins ?? {}));
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const dir = [installed[id]].flat().find((p) => p?.installPath)?.installPath;
    if (!dir) continue;
    // A plugin declares servers in .mcp.json, or in plugin.json `mcpServers` (inline or a file path).
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.mcpServers;
    const mcp = typeof manifest === 'string' ? readJson(path.join(dir, manifest)) : manifest ?? readJson(path.join(dir, '.mcp.json'));
    found.push(...entries(mcp?.mcpServers ?? mcp, 'Claude Code', `plugin ${id}`, env));
  }

  const codexFile = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml');
  if (existsSync(codexFile)) found.push(...entries(codexServers(readFileSync(codexFile, 'utf8')), 'Codex', '~/.codex/config.toml', env));
  return found;
}
