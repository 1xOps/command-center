# 1xOps Command Center

**Your AI agent keeps a terminal open — tests, logs, REPLs and SSH — inside the folders you allow.**

A local MCP server: shell sessions that stay open between turns, plus text-file tools, under one folder limit and one command blocklist that only a person can change. It runs with your permissions and sends nothing anywhere.

| | |
|---|---|
| 🧩 **Clients** | Claude Code (plugin or server only), Claude Desktop (`.mcpb`), OpenAI Codex CLI, VS Code |
| 💻 **Platforms** | macOS, Linux, Windows (Windows not yet run in CI) |
| ⚙️ **Requires** | Node.js 24+ (Claude Desktop installs it from the `.mcpb`) |
| 📦 **Package** | `@1xops/command-center` · MCP Registry `io.github.1xOps/command-center` · 2 runtime deps (MCP SDK, zod) · Apache-2.0 |

## 💼 What teams use it for

| Scenario | Business value |
|---|---|
| 🧪 **Fix failing tests** — run, read failures, edit, re-run in one shell | Environment stays set up; one diff to review |
| 🚨 **Watch logs in an incident** — tail, read on demand, stop when done | Live second pair of eyes; nothing left running |
| 📊 **Check data in a REPL** — `python3 -i` / `node -i` keeps data loaded | Answers from the data itself |
| 🔐 **Diagnose over SSH** — one session kept open | Faster triage; the remote account's permissions are the limit there |
| 🏢 **One team setup** — commit a pinned `.mcp.json` | Every seat runs the same reviewed version |

## 🚀 Install (pinned)

Replace `/path/to/project` with the folders the agent may use; they become `allowedDirectories`.

```bash
# Claude Code: plugin (server + 6 skills) — passes no folder; see Settings
/plugin marketplace add 1xOps/command-center
/plugin install command-center@command-center

# Claude Code: server only
claude mcp add command-center -- npx -y @1xops/command-center@0.4.1 /path/to/project

# OpenAI Codex CLI
codex mcp add command-center -- npx -y @1xops/command-center@0.4.1 /path/to/project
```

<details>
<summary><b>VS Code, Claude Desktop, team setup, container</b></summary>

**VS Code** — `.vscode/mcp.json`:
```json
{ "servers": { "command-center": { "type": "stdio", "command": "npx", "args": ["-y", "@1xops/command-center@0.4.1", "${workspaceFolder}"] } } }
```

**Claude Desktop (macOS, Windows)** — open `command-center-0.4.1.mcpb` from [Releases](https://github.com/1xOps/command-center/releases); it asks which folders to allow.

**Team setup** — commit `.mcp.json` (Codex: same args under `[mcp_servers.command-center]` in `~/.codex/config.toml`):
```json
{ "mcpServers": { "command-center": { "command": "npx", "args": ["-y", "@1xops/command-center@0.4.1", "."] } } }
```
Provenance of a build: `npm view @1xops/command-center@0.4.1 dist.attestations`.

**Container** — from a repo checkout; sees only the mounted folder:
```bash
docker build -t command-center:0.4.1 mcp-server
claude mcp add command-center -- docker run -i --rm --network none -v "/path/to/project:/workspace" command-center:0.4.1
```
</details>

## 🛠️ Tools (20)

| Area | Tools |
|---|---|
| Processes | `start_process`, `interact_with_process`, `read_process_output`, `force_terminate`, `list_sessions` |
| Files (text; images returned as images) | `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `list_directory`, `get_file_info`, `create_directory`, `move_file` |
| Search (ripgrep when installed) | `search`; paged: `start_search`, `get_more_search_results`, `stop_search` |
| System (read-only) | `list_processes` |
| Settings | `get_config`, `set_config_value` |

For PDF, Word, Excel and PowerPoint, use Anthropic's document skills (`pdf`, `docx`, `xlsx`, `pptx`).

## 🛡️ Settings and security

`~/.command-center/config.json` (Windows: `%USERPROFILE%\.command-center\config.json`), created on first start.

| Key | Purpose | Who can change it |
|---|---|---|
| `allowedDirectories` | Folders every file tool and working folder must be inside. Launch folders override it. **Empty = no folder limit** | a person only |
| `blockedCommands` | Programs refused wherever they start a command (defaults include `sudo`, `dd`, `mount`, `diskpart`, `reg`) | a person only |
| `defaultShell` | Session shell (login shell; PowerShell on Windows) | a person only |
| `fileReadLineLimit` / `fileWriteLineLimit` | Lines per read (1000) / per write (50) | person or agent |

<details>
<summary><b>Limits you should know</b></summary>

- Guardrails against mistakes, **not a sandbox**: a program started in a session can reach any path and network you can, and could edit the config file (applies at next start).
- The command check reads command lines — not scripts, REPL input, or what is typed over SSH.
- Each session keeps its last 1 MiB of output in memory; a secret a command prints is visible to the client.
- For untrusted work, use the container. No telemetry or remote calls. See [SECURITY.md](SECURITY.md) · [PRIVACY.md](PRIVACY.md).
</details>

<details>
<summary><b>Development and releases</b></summary>

```bash
npm ci && npm test          # build + all tests
task check                  # every local gate (from the repo root)
task mcp:ci-local           # Linux CI job in the pinned Wolfi image
task mcp:supply-chain       # SBOM against the signed dependency register
task mcp:release-rehearsal  # what would be published, publishing nothing
```

Releases run in CI from a tag `command-center-vX.Y.Z` and publish to npm with provenance (OIDC trusted publishing) only after the owner approves the `release` environment.
</details>

Apache-2.0 © 2026 1xOps. Dependencies keep their own licences; see the [supply-chain register](https://github.com/1xOps/command-center/blob/develop/docs/supply-chain/register.md).
