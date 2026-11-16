import { lstat, readlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowedDirectoriesSource, configDir, configPath, getConfig } from './config.js';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const MAX_LINK_HOPS = 40;

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Where file operations on `absolute` actually land, even when the path does not exist yet.
 * Existing parts are resolved with realpath. A missing part that is a dangling symlink is
 * followed to its target (a write through it would create the target), up to MAX_LINK_HOPS.
 * The still-missing tail is appended to the resolved existing part.
 */
async function resolveReal(absolute: string, hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw new Error(`too many symbolic links resolving ${absolute}`);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = await realpath(probe);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const link = await lstat(probe).then((s) => s.isSymbolicLink(), () => false);
      if (link) {
        const target = path.resolve(path.dirname(probe), await readlink(probe));
        return resolveReal(missing.length ? path.join(target, ...[...missing].reverse()) : target, hops + 1);
      }
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

export function isInside(child: string, parent: string): boolean {
  const [c, p] = CASE_INSENSITIVE_FS ? [child.toLowerCase(), parent.toLowerCase()] : [child, parent];
  const rel = path.relative(p, c);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Returns the canonical (symlink-resolved) path when it is inside `allowedDirectories`.
 * An empty list allows the whole filesystem, as documented. The config folder is always
 * refused: an agent must not edit its own limits with the file tools.
 */
export async function validatePath(requested: string): Promise<string> {
  if (!requested || requested.includes('\0')) throw new Error('path is empty or contains a NUL byte');
  const absolute = path.resolve(expandHome(requested));
  const real = await resolveReal(absolute);
  if (isInside(real, await resolveReal(path.resolve(configDir())))) {
    throw new Error(`refused: ${requested} is in the Command Center settings folder; only a person can change ${configPath()}`);
  }
  const allowed = getConfig().allowedDirectories;
  if (allowed.length === 0) return real;
  for (const dir of allowed) {
    if (isInside(real, await resolveReal(path.resolve(expandHome(dir))))) return real;
  }
  throw new Error(
    `refused: ${requested} is outside allowedDirectories (${allowed.join(', ')}). ` +
      `allowedDirectories is set in ${allowedDirectoriesSource()}; only a person can change it.`,
  );
}

/** Shells: a command that starts one gets its later input checked as command lines too. */
export const SHELLS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'nu', 'xonsh', 'script',
  'powershell', 'pwsh', 'cmd',
]);
/**
 * Remote shells: what is typed into them is a command line on another machine, so it is
 * checked like shell input. The remote account's permissions remain the real limit there.
 * REPLs (python -i, node -i) are not here: their input is code, not command lines.
 */
export const REMOTE_SHELLS = new Set(['ssh', 'mosh']);
// Words that run a later word as the command: POSIX wrappers, shells given a command, and
// their Windows equivalents. After one of these, every later word is checked.
const PREFIX_WORDS = new Set([
  'exec', 'command', 'builtin', 'env', 'nohup', 'time', 'nice', 'xargs', 'stdbuf', 'timeout', 'doas',
  ...SHELLS, ...REMOTE_SHELLS, 'start', 'start-process', 'call',
]);
// Shell grammar words that may precede the command in a simple command.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'case', 'esac', 'in', 'function']);
// Words whose argument is itself a command line the check cannot see into. (`source` and `.`
// run a file; files are not inspected, as documented, so they are not refused here.)
const OPAQUE_WORDS = new Set(['eval', 'invoke-expression', 'iex']);

/**
 * The program a word names, compared case-insensitively and without a Windows executable
 * extension, so `/usr/bin/sudo`, `C:\Windows\System32\DISKPART.EXE` and `diskpart` all match.
 */
export function programName(word: string): string {
  const unquoted = word.replace(/^['"&]+|['"]+$/g, '');
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

/**
 * Guardrail, not a sandbox (see SECURITY.md). The command line is split into simple commands
 * on ; & | newline $( ( ) and backticks. In each, leading assignments and shell keywords are
 * skipped and the program name is compared with blockedCommands; after a wrapper word (env,
 * timeout, sh -c, cmd /c, ...) every later word is compared too. A program reached any other
 * way (a script file, another interpreter, a string built at runtime) is not seen.
 * Returns the program names it found, so callers can tell when a command starts a shell.
 */
export function checkCommand(commandLine: string): string[] {
  const blocked = new Set(getConfig().blockedCommands.map((c) => c.toLowerCase()));
  const refuse = (name: string) => {
    if (OPAQUE_WORDS.has(name)) throw new Error(`refused: \`${name}\` runs text the command check cannot read; run the command directly`);
    if (blocked.has(name)) throw new Error(`refused: \`${name}\` is in blockedCommands. A person can change blockedCommands in ${configPath()}.`);
  };
  const programs: string[] = [];
  for (const segment of commandLine.split(/;|&&?|\|\|?|\n|\$\(|`|\(|\)/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (KEYWORDS.has(words[i] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? ''))) i++;
    const first = words[i];
    if (!first) continue;
    const name = programName(first);
    programs.push(name);
    refuse(name);
    if (PREFIX_WORDS.has(name)) {
      // Wrapper flags and their values are not reliably told apart from the command they run
      // (`timeout -s KILL 5 sudo`), so every later non-flag word is checked as a program.
      for (const word of words.slice(i + 1)) {
        if (/^(-|\/[a-z]$)/i.test(word)) continue;
        const later = programName(word);
        programs.push(later);
        refuse(later);
      }
    }
  }
  return programs;
}
