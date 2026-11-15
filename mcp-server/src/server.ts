import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AGENT_SETTABLE_KEYS, allowedDirectoriesSource, configPath, getConfig, setConfigValue } from './config.js';
import { createDirectory, editBlock, fileInfo, listDirectory, moveFile, readTextOrImage, writeText } from './files.js';
import { interact, listSessions, readOutput, startProcess, terminate, type ProcessResult } from './processes.js';
import { moreResults, search, sessionsKept, startSearch, stopSearch, type SearchPage } from './search.js';
import { listProcesses } from './system.js';
import { SERVER_NAME, VERSION } from './version.js';

const INSTRUCTIONS = `Command Center runs terminal commands in persistent sessions and reads and edits text files on this machine.
Use start_process for builds, tests, logs and REPLs (python3 -i, node -i), then interact_with_process and read_process_output.
File tools work in text; for PDF, Office files and images, use the client's own document features.
Every path must be inside allowedDirectories and every command outside blockedCommands; only a person can change those, in ${'`'}~/.command-center/config.json${'`'}.`;

const timeout = (fallback: number) => z.number().int().min(0).max(600_000).default(fallback).describe('Milliseconds to wait for output before returning');

const processOutput = {
  pid: z.number().int(),
  output: z.string(),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  truncated: z.boolean().describe('true when output older than the last 1 MiB was dropped'),
};

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function processResult(result: ProcessResult): CallToolResult {
  const status = result.running ? 'running' : `exited with code ${result.exitCode}`;
  const head = `pid ${result.pid} ${status}${result.truncated ? ' (older output dropped)' : ''}`;
  return { content: [{ type: 'text', text: result.output ? `${head}\n${result.output}` : head }], structuredContent: { ...result } };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION, title: '1xOps Command Center' }, { instructions: INSTRUCTIONS });

  // ---- Processes -------------------------------------------------------------------------
  server.registerTool('start_process', {
    title: 'Start process',
    description: 'Runs a command in the configured shell as a persistent session and returns its first output. The session keeps running after the call returns; use its pid with interact_with_process, read_process_output and force_terminate.',
    inputSchema: {
      command: z.string().min(1).describe('Command line, for example "npm test" or "python3 -i"'),
      timeout_ms: timeout(5000),
      cwd: z.string().optional().describe('Working directory; defaults to the server process directory'),
    },
    outputSchema: processOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, timeout_ms, cwd }) => processResult(await startProcess(command, timeout_ms, cwd)));

  server.registerTool('interact_with_process', {
    title: 'Send input to a process',
    description: 'Writes a line of input to a running session (a shell, REPL or prompt) and returns the output that follows, including anything not yet read.',
    inputSchema: { pid: z.number().int(), input: z.string(), timeout_ms: timeout(8000) },
    outputSchema: processOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ pid, input, timeout_ms }) => processResult(await interact(pid, input, timeout_ms)));

  server.registerTool('read_process_output', {
    title: 'Read process output',
    description: 'Returns output produced since the last read, waiting up to timeout_ms for new output when there is none.',
    inputSchema: { pid: z.number().int(), timeout_ms: timeout(2000) },
    outputSchema: processOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ pid, timeout_ms }) => processResult(await readOutput(pid, timeout_ms)));

  server.registerTool('force_terminate', {
    title: 'Stop process',
    description: 'Stops a session and its child processes (SIGTERM, then SIGKILL after 2 s) and returns its last output.',
    inputSchema: { pid: z.number().int() },
    outputSchema: processOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ pid }) => processResult(await terminate(pid)));

  server.registerTool('list_sessions', {
    title: 'List sessions',
    description: 'Lists the sessions this server started, running or finished, with unread output counts.',
    outputSchema: {
      sessions: z.array(z.object({
        pid: z.number().int(), command: z.string(), cwd: z.string(), running: z.boolean(),
        exitCode: z.number().int().nullable(), runtimeMs: z.number(), unreadChars: z.number().int(),
      })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const sessions = listSessions();
    const lines = sessions.map((s) => `${s.pid}\t${s.running ? 'running' : `exit ${s.exitCode}`}\t${Math.round(s.runtimeMs / 1000)}s\t${s.command}`);
    return { content: [{ type: 'text', text: lines.join('\n') || 'no sessions' }], structuredContent: { sessions } };
  });

  // ---- Files -----------------------------------------------------------------------------
  server.registerTool('read_file', {
    title: 'Read file',
    description: 'Reads a text file by lines (offset is 0-based; a negative offset reads from the end, e.g. -100 for the last 100 lines) or returns an image (png, jpg, gif, webp). Other binary files are refused.',
    inputSchema: {
      path: z.string().min(1),
      offset: z.number().int().default(0),
      length: z.number().int().min(1).optional().describe('Lines to return; capped at fileReadLineLimit'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, offset, length }) => {
    const result = await readTextOrImage(path, offset, length);
    if (result.kind === 'image') return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] };
    return text(`[${result.path}: lines ${result.fromLine}-${result.toLine} of ${result.totalLines}]\n${result.text}`);
  });

  server.registerTool('read_multiple_files', {
    title: 'Read several files',
    description: 'Reads up to 20 text files from the start (up to fileReadLineLimit lines each). A file that cannot be read is reported without failing the others.',
    inputSchema: { paths: z.array(z.string().min(1)).min(1).max(20) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ paths }) => {
    const parts: CallToolResult['content'] = [];
    for (const p of paths) {
      try {
        const result = await readTextOrImage(p);
        if (result.kind === 'image') parts.push({ type: 'text', text: `--- ${result.path} (image)` }, { type: 'image', data: result.data, mimeType: result.mimeType });
        else parts.push({ type: 'text', text: `--- ${result.path}: lines ${result.fromLine}-${result.toLine} of ${result.totalLines}\n${result.text}` });
      } catch (error) {
        parts.push({ type: 'text', text: `--- ${p}: ${(error as Error).message}` });
      }
    }
    return { content: parts };
  });

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Writes text to a file (mode "rewrite" replaces it, "append" adds to the end), creating parent folders. Content over fileWriteLineLimit lines is refused: write it in chunks with "append".',
    inputSchema: { path: z.string().min(1), content: z.string(), mode: z.enum(['rewrite', 'append']).default('rewrite') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path, content, mode }) => {
    const result = await writeText(path, content, mode);
    return text(`${mode === 'append' ? 'appended' : 'wrote'} ${result.lines} lines to ${result.path}`);
  });

  server.registerTool('edit_block', {
    title: 'Edit text in a file',
    description: 'Replaces old_string with new_string when it occurs exactly expected_replacements times. Otherwise nothing changes and the reply shows the count, or the closest passage when there is no exact match.',
    inputSchema: {
      file_path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      expected_replacements: z.number().int().min(1).default(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ file_path, old_string, new_string, expected_replacements }) => text(await editBlock(file_path, old_string, new_string, expected_replacements)));

  server.registerTool('list_directory', {
    title: 'List directory',
    description: 'Lists a folder recursively to the given depth, marking [DIR], [FILE] and [LINK]; stops at 1000 entries.',
    inputSchema: { path: z.string().min(1), depth: z.number().int().min(1).max(5).default(2) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, depth }) => {
    const result = await listDirectory(path, depth);
    return text(`${result.path}\n${result.entries.join('\n')}${result.truncated ? '\n[stopped at 1000 entries; list a subfolder]' : ''}`);
  });

  server.registerTool('get_file_info', {
    title: 'File information',
    description: 'Returns type, size, times, permissions and, for text files, the line count.',
    inputSchema: { path: z.string().min(1) },
    outputSchema: {
      path: z.string(), type: z.string(), size: z.number(), modified: z.string(), created: z.string(), mode: z.string(),
      lines: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path }) => {
    const info = await fileInfo(path);
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }], structuredContent: info };
  });

  server.registerTool('create_directory', {
    title: 'Create directory',
    description: 'Creates a folder and any missing parents; an existing folder is left as it is.',
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path }) => text(`created ${await createDirectory(path)}`));

  server.registerTool('move_file', {
    title: 'Move or rename',
    description: 'Moves or renames a file or folder. Refuses when the destination already exists.',
    inputSchema: { source: z.string().min(1), destination: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ source, destination }) => {
    const moved = await moveFile(source, destination);
    return text(`moved ${moved.from} to ${moved.to}`);
  });

  // ---- Search ----------------------------------------------------------------------------
  server.registerTool('search', {
    title: 'Search files',
    description: 'Searches file contents (kind "content", one "file:line:text" per match; pattern is a regular expression unless literal is true) or file names (kind "files"; pattern is plain text in the name) under a folder. Uses ripgrep when it is installed (respects .gitignore), otherwise a built-in search that skips .git, node_modules and build folders.',
    inputSchema: {
      path: z.string().min(1),
      pattern: z.string().min(1).describe('Regular expression, or plain text when literal is true'),
      kind: z.enum(['content', 'files']).default('content'),
      glob: z.string().optional().describe('Only files whose name matches, e.g. "*.ts"'),
      ignore_case: z.boolean().default(false),
      literal: z.boolean().default(false),
      max_results: z.number().int().min(1).max(1000).default(100),
      timeout_ms: z.number().int().min(100).max(120_000).default(30_000),
    },
    outputSchema: { engine: z.enum(['ripgrep', 'node']), matches: z.array(z.string()), truncated: z.boolean(), timedOut: z.boolean(), warnings: z.array(z.string()) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const result = await search({
      path: args.path, pattern: args.pattern, kind: args.kind, glob: args.glob, ignoreCase: args.ignore_case,
      literal: args.literal, maxResults: args.max_results, timeoutMs: args.timeout_ms,
    });
    const notes = [result.truncated && `stopped at ${args.max_results} results`, result.timedOut && `stopped after ${args.timeout_ms} ms`, ...result.warnings].filter(Boolean);
    const body = result.matches.join('\n') || 'no matches';
    return { content: [{ type: 'text', text: notes.length ? `${body}\n[${notes.join('; ')}]` : body }], structuredContent: { ...result } };
  });

  const searchInput = {
    path: z.string().min(1),
    pattern: z.string().min(1).describe('Regular expression, or plain text when literal is true'),
    kind: z.enum(['content', 'files']).default('content'),
    glob: z.string().optional().describe('Only files whose name matches, e.g. "*.ts"'),
    ignore_case: z.boolean().default(false),
    literal: z.boolean().default(false),
  };
  const pageOutput = {
    id: z.string(), running: z.boolean(), stopped: z.boolean(), offset: z.number().int(), matches: z.array(z.string()), totalSoFar: z.number().int(),
    truncated: z.boolean(), timedOut: z.boolean(), warnings: z.array(z.string()), error: z.string().optional(),
  };
  const pageResult = (p: SearchPage): CallToolResult => {
    const state = p.error ? `failed: ${p.error}` : p.running ? 'still running' : p.stopped ? `stopped, ${p.totalSoFar} results kept` : `finished, ${p.totalSoFar} results${p.truncated ? ' (stopped at max_results)' : ''}${p.timedOut ? ' (stopped at timeout)' : ''}`;
    const range = p.matches.length ? `results ${p.offset + 1}-${p.offset + p.matches.length}` : 'no results in this page';
    return { content: [{ type: 'text', text: `${p.id} ${state}; ${range}\n${p.matches.join('\n')}`.trimEnd() }], structuredContent: { ...p } };
  };

  server.registerTool('start_search', {
    title: 'Start a paged search',
    description: 'Starts a large search in the background (same options as search, up to 10000 results) and returns an id with the first page as soon as it is full. Results can be read while the search runs. Read further pages with get_more_search_results; end it early with stop_search. Use search instead for small result sets.',
    inputSchema: {
      ...searchInput,
      max_results: z.number().int().min(1).max(10_000).default(2000),
      timeout_ms: z.number().int().min(100).max(600_000).default(120_000),
      page_size: z.number().int().min(1).max(500).default(100),
      wait_ms: z.number().int().min(0).max(60_000).default(3000).describe('How long to wait for results before returning'),
    },
    outputSchema: pageOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => pageResult(await startSearch({
    path: args.path, pattern: args.pattern, kind: args.kind, glob: args.glob, ignoreCase: args.ignore_case,
    literal: args.literal, maxResults: args.max_results, timeoutMs: args.timeout_ms,
  }, args.wait_ms, args.page_size)));

  server.registerTool('get_more_search_results', {
    title: 'Next page of a search',
    description: 'Returns results offset..offset+length of a search started with start_search, waiting up to wait_ms for them while it is still running.',
    inputSchema: {
      id: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(500).default(100),
      wait_ms: z.number().int().min(0).max(60_000).default(3000),
    },
    outputSchema: pageOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, offset, length, wait_ms }) => pageResult(await moreResults(id, offset, length, wait_ms)));

  server.registerTool('stop_search', {
    title: 'Stop a search',
    description: 'Stops a search started with start_search if it is still running; the results found so far stay readable with get_more_search_results. Calling it again on the same id frees the results.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ id }) => {
    const stopped = await stopSearch(id);
    if (!stopped) return text(`no search with id ${id}`);
    return text(sessionsKept(id) ? `stopped ${id}; ${stopped.totalSoFar} results kept (call again to free them)` : `freed ${id}`);
  });

  // ---- System ----------------------------------------------------------------------------
  server.registerTool('list_processes', {
    title: 'List system processes',
    description: 'Lists the operating system\'s processes (pid, parent pid, name, memory), largest memory first. Read-only; stop a session this server started with force_terminate.',
    inputSchema: {
      filter: z.string().optional().describe('Only processes whose name contains this text (case-insensitive)'),
      limit: z.number().int().min(1).max(2000).default(50),
    },
    outputSchema: {
      total: z.number().int(),
      processes: z.array(z.object({ pid: z.number().int(), ppid: z.number().int(), name: z.string(), memoryKb: z.number() })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ filter, limit }) => {
    const result = await listProcesses(filter, limit);
    const lines = result.processes.map((p) => `${p.pid}\t${p.ppid}\t${Math.round(p.memoryKb / 1024)} MB\t${p.name}`);
    return { content: [{ type: 'text', text: `${result.total} processes${filter ? ` matching "${filter}"` : ''}; showing ${lines.length}\npid\tppid\tmemory\tname\n${lines.join('\n')}` }], structuredContent: result };
  });

  // ---- Config ----------------------------------------------------------------------------
  server.registerTool('get_config', {
    title: 'Show settings',
    description: 'Shows the active settings and the file they come from.',
    outputSchema: {
      file: z.string(), allowedDirectoriesFrom: z.string(), allowedDirectories: z.array(z.string()), blockedCommands: z.array(z.string()), defaultShell: z.string(),
      fileReadLineLimit: z.number().int(), fileWriteLineLimit: z.number().int(), version: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const view = { file: configPath(), allowedDirectoriesFrom: allowedDirectoriesSource(), ...getConfig(), version: VERSION };
    return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }], structuredContent: view };
  });

  server.registerTool('set_config_value', {
    title: 'Change a setting',
    description: `Changes ${AGENT_SETTABLE_KEYS.join(' or ')}. allowedDirectories, blockedCommands and defaultShell are refused: only a person can change them, in the config file.`,
    // Required (unlike z.unknown()), so a missing value is an error, never a silent reset.
    inputSchema: { key: z.string().min(1), value: z.union([z.number(), z.string(), z.array(z.string())]).describe('New value, e.g. 2000 for a line limit') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ key, value }) => {
    await setConfigValue(key, value);
    return text(`${key} set to ${JSON.stringify(value)} in ${configPath()}`);
  });

  return server;
}
