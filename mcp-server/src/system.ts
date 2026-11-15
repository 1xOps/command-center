// list_processes: a read-only view of the operating system's processes. Fixed commands with
// no user input, spawned without a shell, so blockedCommands does not apply.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export interface OsProcess {
  pid: number;
  ppid: number;
  name: string;
  memoryKb: number;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      error ? reject(new Error(`${file} failed: ${error.message}`)) : resolve(stdout));
  });

/**
 * The name to show for a Linux process. comm (the kernel's name, cut at 15 characters) is right
 * unless the program renamed its main thread (Node 24 calls it "MainThread"); then the program
 * path from cmdline is used, and also when comm was cut and cmdline holds the longer name.
 * Daemons that rewrite cmdline ("sshd: os@pts/0") keep comm.
 */
export function linuxName(comm: string, cmdline: string): string {
  const argv0 = cmdline.split('\0')[0]?.split(' ')[0] ?? '';
  const base = argv0.split('/').pop() ?? '';
  if (!base) return comm;
  if (comm === 'MainThread') return base;
  // comm is cut at 15 characters; only then can the full name in cmdline add anything.
  return comm.length === 15 && base.startsWith(comm) ? base : comm;
}

/** Linux: /proc is always there (minimal images ship a busybox ps without the fields we need). */
async function linux(): Promise<OsProcess[]> {
  const list: OsProcess[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // status gives the parent and resident memory already in kB, whatever the kernel's page size.
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim() ?? '';
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
      list.push({
        pid: Number(entry),
        ppid: Number(field('PPid')),
        name: linuxName(field('Name'), cmdline),
        memoryKb: Number.parseInt(field('VmRSS'), 10) || 0, // kernel threads have no VmRSS
      });
    } catch {
      // The process ended between readdir and read: not an error.
    }
  }
  return list;
}

async function macos(): Promise<OsProcess[]> {
  const out = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,comm=']);
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), memoryKb: Number(m[3]), name: (m[4] ?? '').split('/').pop() ?? '' }] : [];
  });
}

async function windows(): Promise<OsProcess[]> {
  // UTF-8 output, so names outside the OEM code page survive the pipe.
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress';
  const out = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  const rows = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; WorkingSetSize: number }>;
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name ?? '', memoryKb: Math.round(Number(r.WorkingSetSize ?? 0) / 1024),
  }));
}

/** Processes whose name contains `filter` (case-insensitive), largest memory first, at most `limit`. */
export async function listProcesses(filter: string | undefined, limit: number): Promise<{ processes: OsProcess[]; total: number }> {
  const all = process.platform === 'win32' ? await windows() : process.platform === 'linux' ? await linux() : await macos();
  const needle = filter?.toLowerCase();
  const matched = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all;
  matched.sort((a, b) => b.memoryKb - a.memoryKb);
  return { processes: matched.slice(0, limit), total: matched.length };
}
