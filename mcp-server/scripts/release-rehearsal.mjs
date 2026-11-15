// `task mcp:release-rehearsal` — "What exactly would we publish?" Packs the npm tarball and the
// Claude Desktop bundle locally, lists their contents and sizes, and fails if the npm package
// would ship anything outside the expected files. Publishes nothing.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WINDOWS = process.platform === 'win32';
const npm = WINDOWS ? 'npm.cmd' : 'npm';
const run = (args) => execFileSync(npm, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: WINDOWS });

run(['run', 'build']);
const [pack] = JSON.parse(run(['pack', '--dry-run', '--json', '--ignore-scripts']));
const allowed = /^(dist\/.+\.js|package\.json|README\.md|LICENSE|icon\.png)$/;
const unexpected = pack.files.map((f) => f.path).filter((p) => !allowed.test(p));
console.log(`npm: ${pack.id}  ${pack.files.length} files  ${(pack.size / 1024).toFixed(1)} KiB packed, ${(pack.unpackedSize / 1024).toFixed(1)} KiB unpacked`);
for (const p of unexpected) console.log(`FAIL  unexpected file in npm package: ${p}`);

execFileSync(process.execPath, [path.join(root, 'scripts', 'build-mcpb.mjs')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const mcpb = path.join(root, `command-center-${pack.version}.mcpb`);
console.log(`Claude Desktop: ${path.basename(mcpb)}  ${(statSync(mcpb).size / 1024 / 1024).toFixed(1)} MiB`);
console.log(unexpected.length ? 'FAIL' : 'PASS (nothing published)');
process.exitCode = unexpected.length ? 1 : 0;
