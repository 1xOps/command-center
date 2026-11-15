// npm links bin entries as executables; the entry point must carry the exec bit.
import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
