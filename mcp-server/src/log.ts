// stdout carries JSON-RPC only (MCP stdio transport). Every diagnostic goes to stderr,
// which MCP clients capture as the server log.
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`${new Date().toISOString()} command-center ${level}: ${message}\n`);
}
