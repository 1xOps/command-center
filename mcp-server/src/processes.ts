import { spawn, type ChildProcess } from 'node:child_process';
import { getConfig } from './config.js';
import { log } from './log.js';
import { checkCommand, programName, SHELLS, validatePath } from './policy.js';

const MAX_BUFFER = 1024 * 1024; // keep the last 1 MiB of output per session
const MAX_SESSIONS = 50;
const IDLE_MS = 400; // output is "settled" after this long without new bytes
const IS_WINDOWS = process.platform === 'win32';

const PS_EXIT = 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

/** How each shell is told to run one command line. */
export function shellArgs(shell: string, command: string): string[] {
  const name = programName(shell);
  // Windows PowerShell 5.1 ends -Command with exit code 1 for any failure, hiding a program's
  // own code; this line after the command passes the real code on (pwsh 7 behaves the same way).
  if (name === 'powershell' || name === 'pwsh') return ['-NoLogo', '-NoProfile', '-Command', `${command}\n${PS_EXIT}`];
  // With /s, cmd strips the first and last quote of the line, so the whole line is wrapped in
  // quotes (as Node does for shell: true) and arguments are passed verbatim.
  if (name === 'cmd') return ['/d', '/s', '/c', `"${command}"`];
  return ['-c', command];
}

interface Session {
  pid: number;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  output: string;
  /** Characters dropped from the front of `output` because of MAX_BUFFER. */
  dropped: number;
  /** Absolute offset (including dropped characters) up to which output was returned. */
  cursor: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exited: boolean;
  /** Input to an interactive shell is checked against blockedCommands like a command line. */
  checkInput: boolean;
  listeners: Set<() => void>;
}

const sessions = new Map<number, Session>();

export interface ProcessResult {
  pid: number;
  output: string;
  running: boolean;
  exitCode: number | null;
  truncated: boolean;
}

function notify(session: Session): void {
  for (const listener of session.listeners) listener();
}

function append(session: Session, chunk: string): void {
  session.output += chunk;
  // Trim in steps (not on every chunk) and never between the halves of a surrogate pair.
  if (session.output.length > MAX_BUFFER * 1.25) {
    let cut = session.output.length - MAX_BUFFER;
    const code = session.output.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut++;
    session.output = session.output.slice(cut);
    session.dropped += cut;
  }
  notify(session);
}

function prune(): void {
  if (sessions.size < MAX_SESSIONS) return;
  const finished = [...sessions.values()].filter((s) => s.exited).sort((a, b) => a.startedAt - b.startedAt);
  for (const s of finished.slice(0, sessions.size - MAX_SESSIONS + 1)) sessions.delete(s.pid);
  if (sessions.size >= MAX_SESSIONS) throw new Error(`${MAX_SESSIONS} sessions are running; stop one with force_terminate first`);
}

/** Waits until the process exits, its output has been idle for IDLE_MS, or the timeout passes. */
function settle(session: Session, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (session.exited || timeoutMs <= 0) return resolve();
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(deadline);
      clearTimeout(idle);
      session.listeners.delete(onChange);
      resolve();
    };
    const onChange = () => {
      if (session.exited) return finish();
      clearTimeout(idle);
      idle = setTimeout(finish, IDLE_MS);
    };
    const deadline = setTimeout(finish, timeoutMs);
    session.listeners.add(onChange);
  });
}

function take(session: Session): ProcessResult {
  const start = Math.max(session.cursor - session.dropped, 0);
  const truncated = session.cursor < session.dropped;
  const output = session.output.slice(start);
  session.cursor = session.dropped + session.output.length;
  return { pid: session.pid, output, running: !session.exited, exitCode: session.exitCode, truncated };
}

function get(pid: number): Session {
  const session = sessions.get(pid);
  if (!session) throw new Error(`no session with pid ${pid}; list_sessions shows the live ones`);
  return session;
}

export async function startProcess(command: string, timeoutMs: number, cwd?: string): Promise<ProcessResult> {
  const programs = checkCommand(command);
  prune();
  // Without a cwd, start in the first allowed folder (Claude Desktop starts servers in /).
  const workdir = await validatePath(cwd ?? getConfig().allowedDirectories[0] ?? process.cwd());
  const shell = getConfig().defaultShell;
  // POSIX: detached makes the child lead its own process group, so force_terminate stops its
  // children too. Windows: taskkill /T stops the tree instead, and windowsHide keeps it consoleless.
  const child = spawn(shell, shellArgs(shell, command), {
    cwd: workdir, detached: !IS_WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    // cmd.exe parses its own quoting; Node's default escaping would break `cmd /s /c "..."`.
    windowsVerbatimArguments: IS_WINDOWS && programName(shell) === 'cmd',
  });
  const pid = child.pid;
  if (pid === undefined) {
    const error = await new Promise<Error>((resolve) => child.once('error', resolve));
    throw new Error(`could not start ${shell}: ${error.message}`);
  }
  const session: Session = {
    pid, command, cwd: workdir, child, startedAt: Date.now(), output: '', dropped: 0, cursor: 0,
    exitCode: null, signal: null, exited: false, checkInput: programs.some((p) => SHELLS.has(p)), listeners: new Set(),
  };
  sessions.set(pid, session);
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => append(session, chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => append(session, chunk));
  // Needed so a broken pipe never crashes the server; interact() reports the failed write itself.
  child.stdin?.on('error', () => undefined);
  child.on('error', (error) => append(session, `\n[command-center] process error: ${error.message}\n`));
  child.on('close', (code, signal) => {
    session.exited = true;
    session.exitCode = code;
    session.signal = signal;
    notify(session);
  });
  await settle(session, timeoutMs);
  return take(session);
}

export async function interact(pid: number, input: string, timeoutMs: number): Promise<ProcessResult> {
  const session = get(pid);
  if (session.exited) throw new Error(`process ${pid} has exited (code ${session.exitCode}); start a new one`);
  if (session.checkInput) checkCommand(input);
  const stdin = session.child.stdin;
  if (!stdin || !stdin.writable) throw new Error(`process ${pid} is running but no longer reads input (its stdin is closed)`);
  // Resolves once the bytes reach the pipe; rejects (EPIPE) if the process closed its input.
  await new Promise<void>((resolve, reject) => {
    stdin.write(input.endsWith('\n') ? input : `${input}\n`, (error) => (error ? reject(new Error(`input not delivered to ${pid}: ${error.message}`)) : resolve()));
  });
  // The result includes any output not yet read, followed by the reply to this input.
  await settle(session, timeoutMs);
  return take(session);
}

export async function readOutput(pid: number, timeoutMs: number): Promise<ProcessResult> {
  const session = get(pid);
  if (session.cursor === session.dropped + session.output.length) await settle(session, timeoutMs);
  return take(session);
}

export async function terminate(pid: number): Promise<ProcessResult> {
  const session = get(pid);
  if (!session.exited) {
    signalGroup(session, 'SIGTERM');
    await settle(session, 2000);
    if (!session.exited) {
      signalGroup(session, 'SIGKILL');
      await settle(session, 2000);
    }
  }
  if (!session.exited) {
    // Keep the session so the caller can see it and retry; never report a live process as stopped.
    throw new Error(`process ${pid} did not exit after SIGTERM and SIGKILL; it is still listed by list_sessions`);
  }
  const result = take(session);
  sessions.delete(pid);
  return result;
}

function signalGroup(session: Session, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    // No process groups or POSIX signals on Windows: taskkill stops the whole tree (/T).
    // /F always: without it taskkill sends WM_CLOSE, which windowless console processes ignore.
    const args = ['/PID', String(session.pid), '/T', '/F'];
    spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
      .on('error', (error) => {
        log('warn', `taskkill could not run (${error.message}); stopping only the shell of ${session.pid}`);
        session.child.kill();
      })
      .on('close', (code) => {
        // 128 = no such process (already gone); anything else is a real failure.
        if (code !== 0 && code !== 128 && !session.exited) log('warn', `taskkill ${args.join(' ')} exited ${code}`);
      });
    return;
  }
  try {
    process.kill(-session.pid, signal);
  } catch {
    try { session.child.kill(signal); } catch { /* already gone */ }
  }
}

export function listSessions(): Array<{ pid: number; command: string; cwd: string; running: boolean; exitCode: number | null; runtimeMs: number; unreadChars: number }> {
  return [...sessions.values()].map((s) => ({
    pid: s.pid,
    command: s.command,
    cwd: s.cwd,
    running: !s.exited,
    exitCode: s.exitCode,
    runtimeMs: Date.now() - s.startedAt,
    unreadChars: s.dropped + s.output.length - s.cursor,
  }));
}

/** Stops every session; called when the client disconnects or the server is signalled. */
export function stopAll(): void {
  for (const session of sessions.values()) if (!session.exited) signalGroup(session, 'SIGKILL');
}
