# Command Center plugin (Claude Code)

Installs the 1xOps Command Center MCP server, pinned to `@1xops/command-center@0.4.0`, and six skills that teach the agent to use it well.

```
/plugin marketplace add 1xOps/command-center
/plugin install command-center@command-center
```

| Skill | Use it for |
|---|---|
| `command-center-overview` | which tool for which job, and the limits |
| `terminal` | shells, REPLs, SSH, processes and ports, saving workflows as scripts |
| `ai-tools-setup` | adding and repairing MCP servers in Claude Desktop, Claude Code and Codex |
| `computer-health-check` | a read-only health check of macOS, Linux or Windows with opt-in cleanups |
| `knowledge-base` | a Markdown knowledge base any agent can navigate |
| `obsidian-vault` | organising an Obsidian vault from its files |

The server and its settings are documented in [`mcp-server/README.md`](../../mcp-server/README.md).
