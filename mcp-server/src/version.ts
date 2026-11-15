import { readFileSync } from 'node:fs';

// One source of truth: package.json, which npm, the plugin and the registry all read.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION: string = pkg.version;
export const SERVER_NAME = 'command-center';
