---
name: ai-tools-setup
description: Installs, connects, checks and repairs MCP servers (Command Center or others) in Claude Code, Claude Desktop, OpenAI Codex, Gemini CLI, Cursor and VS Code, with config locations for macOS, Linux and Windows and a repeatable proof that the server answers. Use when the person wants to add an MCP server or asks why a server is missing or its tools fail.
---

# Set up and repair AI tool connections

Work in three steps: **find** the client's config, **change** it only with the person's agreement, **prove** the server answers.

## 1 · Find the config

| Client | Where MCP servers are configured | Command line |
|---|---|---|
| Claude Code | `.mcp.json` in the project (team), or `~/.claude.json` (personal) | `claude mcp list`, `claude mcp add` |
| Claude Desktop | Settings → Extensions (`.mcpb` bundles), or `claude_desktop_config.json` (see `references/claude-desktop.md`) | none |
| OpenAI Codex | `~/.codex/config.toml`, section `[mcp_servers.<name>]` | `codex mcp list`, `codex mcp add` |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`), or a `gemini-extension.json` extension | `gemini mcp list` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` in the project | Settings → MCP |
| VS Code | `.vscode/mcp.json` (`servers`) or the user profile | `MCP: List Servers` command |

Read the file with `command-center:read_file` before proposing any change. Config files can hold tokens: never print a secret back to the person; refer to it by key name.

## 2 · Change it

- Show the exact lines to add, and add them only after the person agrees.
- Pin versions (`@1xops/command-center@0.4.0`), never `@latest`, so every machine runs the same code.
- Keep JSON valid: after `command-center:write_file` or `command-center:edit_block`, read it back with `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <file>`.
- Command Center's allowed folders come from the launch arguments (`npx -y @1xops/command-center@0.4.0 /path/one /path/two`) or from `~/.command-center/config.json`. Agents cannot change them.

## 3 · Prove it works

1. The client lists the server (`claude mcp list`, `codex mcp list`, `gemini mcp list`, or the settings page).
2. A tool call succeeds: for Command Center, `command-center:get_config` returns the version and the allowed folders.
3. Restart the client after a config change; most read MCP config only at start.

## Common failures

| Symptom | Likely cause | Check |
|---|---|---|
| Server missing from the list | config file in the wrong place, or invalid JSON/TOML | parse the file; compare the path with the table above |
| "spawn npx ENOENT" | Node is not on the client's PATH (common for desktop apps on macOS) | `which npx`; use the absolute path to `npx` in the config |
| Starts then disconnects | the server crashed: wrong Node version, or a bad argument | run the same command in `command-center:start_process` and read stderr; Command Center needs Node 24+ |
| Tools refuse every path | allowed folders not set, or set to other folders | `command-center:get_config` → `allowedDirectories` and `allowedDirectoriesFrom` |
| Works in one project only | it is configured in that project's `.mcp.json` | add it at user scope, if the person wants that |

## Stay within limits

- Do not install software or change system settings without the person's yes.
- Do not copy tokens between clients. Ask the person to paste a secret into the client's own settings.
