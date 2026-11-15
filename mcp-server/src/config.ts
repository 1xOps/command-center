import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_BLOCKED_COMMANDS = [
  // Disks and filesystems
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
  // Privilege and accounts
  'sudo', 'su', 'doas', 'passwd', 'adduser', 'useradd', 'usermod', 'userdel', 'groupadd', 'chsh', 'visudo',
  // System state
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'systemctl', 'launchctl',
  // Network and firewall
  'iptables', 'nft', 'ufw', 'firewall-cmd', 'pfctl',
  // Windows (matched without .exe, ignoring case)
  'bcdedit', 'reg', 'net', 'sc', 'takeown', 'icacls', 'cipher', 'runas', 'netsh', 'sfc',
] as const;

/** macOS and Linux: the login shell. Windows: Windows PowerShell, present on every supported version. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/sh';
}

const ConfigSchema = z.object({
  allowedDirectories: z.array(z.string().min(1)).default([]),
  blockedCommands: z.array(z.string().min(1)).default([...DEFAULT_BLOCKED_COMMANDS]),
  defaultShell: z.string().min(1).default(defaultShell),
  fileReadLineLimit: z.number().int().min(1).max(100_000).default(1000),
  fileWriteLineLimit: z.number().int().min(1).max(100_000).default(50),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Keys an agent may change through `set_config_value`. Security keys are file-only. */
export const AGENT_SETTABLE_KEYS = ['fileReadLineLimit', 'fileWriteLineLimit'] as const;
export type AgentSettableKey = (typeof AGENT_SETTABLE_KEYS)[number];

/** Keys only a person can change, by editing the config file. */
export const FILE_ONLY_KEYS = ['allowedDirectories', 'blockedCommands', 'defaultShell'] as const;

export function configDir(): string {
  return process.env.COMMAND_CENTER_CONFIG_DIR || path.join(os.homedir(), '.command-center');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

let current: Config | undefined;
/** Folders given as launch arguments (Claude Desktop's folder picker, or a team's MCP config). */
let launchDirectories: string[] | undefined;

/**
 * Launch arguments set allowedDirectories for this session and take precedence over the file:
 * they were chosen by the person who installed or configured the client, not by the agent.
 */
export function setLaunchDirectories(dirs: string[]): void {
  launchDirectories = dirs.length ? dirs.map((d) => path.resolve(d)) : undefined;
}

/** Where allowedDirectories comes from, for refusal messages and get_config. */
export function allowedDirectoriesSource(): string {
  return launchDirectories
    ? 'the server launch arguments (the folders chosen when the MCP client was installed or configured)'
    : configPath();
}

/**
 * Loads the config file. A missing file means defaults (written once, so a person can edit them).
 * An invalid file stops the server (fail closed): falling back to defaults would replace a
 * person's locked-down allowedDirectories with "no folder limit". The file is left untouched so
 * the person can fix it.
 */
export async function loadConfig(): Promise<Config> {
  const file = configPath();
  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (raw === undefined) {
    current = ConfigSchema.parse({});
    await saveConfig(current);
    return current;
  }
  try {
    current = ConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`config ${file} is not valid, so Command Center will not start (fail closed): ${(error as Error).message}. Fix the file, or delete it to recreate the defaults.`);
  }
  return current;
}

export function getConfig(): Config {
  if (!current) throw new Error('config not loaded: call loadConfig() first');
  return launchDirectories ? { ...current, allowedDirectories: launchDirectories } : current;
}

/** Atomic write: a private temp file in the same folder, flushed, then renamed over the target. */
export async function saveConfig(config: Config): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `config.json.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, configPath());
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  current = config;
}

export async function setConfigValue(key: string, value: unknown): Promise<Config> {
  if ((FILE_ONLY_KEYS as readonly string[]).includes(key)) {
    throw new Error(`${key} can only be changed by a person, in ${configPath()}; agents cannot widen their own access`);
  }
  if (!(AGENT_SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown setting ${key}; settable keys: ${AGENT_SETTABLE_KEYS.join(', ')}`);
  }
  if (!current) throw new Error('config not loaded: call loadConfig() first');
  // Built from the file's values, so launch-argument folders are never written to the file.
  const next = ConfigSchema.parse({ ...current, [key]: value });
  await saveConfig(next);
  return next;
}
