// Runs the built-in search off the main thread, so a slow regular expression can be stopped
// (worker.terminate) instead of freezing the server. Matches go to the parent in batches as they
// are found, so a paged search shows results while it runs; the final message carries the rest.
import { parentPort, workerData } from 'node:worker_threads';
import { nodeSearch, type SearchInput } from './search.js';

const BATCH = 100; // matches per message: few messages, and a page of results arrives quickly
const { root, input } = workerData as { root: string; input: SearchInput };
let batch: string[] = [];
const flush = () => { if (batch.length) { parentPort?.postMessage({ batch }); batch = []; } };
nodeSearch(root, input, (match) => { batch.push(match); if (batch.length >= BATCH) flush(); }).then(
  (result) => { flush(); parentPort?.postMessage({ ok: true, result: { ...result, matches: [] } }); },
  (error: unknown) => { flush(); parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); },
);
