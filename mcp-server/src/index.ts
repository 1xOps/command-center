#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { loadConfig, setLaunchDirectories } from './config.js';
import { log } from './log.js';
import { stopAll as stopSessions } from './processes.js';
import { stopAllSearches } from './search.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

/** Stops every session and background search; safe to call more than once. */
function stopAll(): void {
  stopSessions();
  stopAllSearches();
}

const USAGE = `Usage: command-center [folder ...]

Runs the 1xOps Command Center MCP server on stdio.
Folders given here become allowedDirectories for this session, overriding the config file
(~/.command-center/config.json). With none, the config file decides.

  --version   print the version
  --help      print this help`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${USAGE}\n`); return; }
  if (args.includes('--version')) { process.stdout.write(`${VERSION}\n`); return; }
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length) throw new Error(`unknown option ${unknown.join(' ')}\n${USAGE}`);
  for (const dir of args) if (!existsSync(dir)) log('warn', `launch folder ${dir} does not exist yet`);

  await loadConfig();
  setLaunchDirectories(args);
  const server = createServer();
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    log('info', `shutting down (${reason})`);
    stopAll();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  // Sessions run in their own process groups, so they must be stopped on every way out.
  process.on('exit', stopAll);
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The client closing stdin is the normal end of a stdio session.
  process.stdin.on('end', () => void shutdown('client closed stdin'));

  await server.connect(transport);
  log('info', `version ${VERSION} ready on stdio`);
}

main().catch((error: unknown) => {
  log('error', error instanceof Error ? (error.stack ?? error.message) : String(error));
  stopAll();
  process.exit(1);
});
