// Each test file gets its own config folder and scratch folder under the OS temp dir,
// named for the product so a leftover is easy to trace, and removed after the run.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function scratch(t, purpose) {
  // .native resolves Windows 8.3 short names (RUNNER~1) the way the server's realpath does.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `command-center-test-${purpose}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Points the config module at a fresh folder; call before importing dist modules. */
export function isolateConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'command-center-test-config-'));
  process.env.COMMAND_CENTER_CONFIG_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
