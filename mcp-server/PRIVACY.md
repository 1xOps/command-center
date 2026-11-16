# Privacy

**Effective:** 16 November 2026 · **Maintainer:** 1xOps

1xOps Command Center is a local MCP server. **It collects no data and sends no data to 1xOps or anyone else.**

- **No telemetry, analytics, update checks or remote services.** The server talks only to the MCP client that started it, over stdio.
- **Local files only.** Settings are kept in `~/.command-center/config.json`. Nothing else is written there.
- **Network use you request.** The server reaches the network only when the agent runs a command that does, for example `curl` or `git pull`.

Your MCP client (Claude, OpenAI or another) has its own privacy terms for what it sends to its model provider.

Questions: open an issue at https://github.com/1xOps/command-center/issues.
