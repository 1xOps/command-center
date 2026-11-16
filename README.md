<p align="center"><img src="mcp-server/logo.png" width="120" alt="1xOps Command Center"></p>

# 1xOps Command Center

**Your AI agent keeps a terminal open — tests, logs, REPLs and SSH — inside the folders you allow.**

A local MCP server: shell sessions that stay open between turns, plus text-file tools, under one folder limit and one command blocklist that only a person can change. It runs on your machine with your permissions and sends nothing anywhere.

```
/plugin marketplace add 1xOps/command-center
/plugin install command-center@command-center
```

## 💼 What teams use it for

| Scenario | How it works | Why it helps |
|---|---|---|
| 🧪 **Fix a failing test suite** | Run the tests, read the failures, edit, run again — in the same shell | The environment stays set up; the engineer reviews one diff |
| 🚨 **Watch logs during an incident** | Start a tail, read new output on demand, stop it with `force_terminate` | A second pair of eyes on live output; nothing left running afterwards |
| 📊 **Check data in a REPL** | `python3 -i` or `node -i` keeps the data loaded across turns | Answers come from the data, not from a script re-run each time |
| 🔐 **Diagnose a server over SSH** | One `ssh` session kept open across turns | Faster remote triage. The blocklist checks the remote command and each typed line; the remote account's permissions are still the real limit |
| 🏢 **One approved setup for the team** | Commit a pinned `.mcp.json` | Every seat runs the same reviewed version |

<details>
<summary><b>🤔 Already have Claude Code or Codex? Do you still need this?</b></summary>

**You probably don't** if you work in your own repository with Codex, or with Claude Code and no need for sessions that stay open between turns. **You do** if one of these rows is yours:

| You need | Why it matters | With Command Center | Without it |
|---|---|---|---|
| 🖥️ **Shell and file tools in Claude Desktop chat** | Not everyone on the team works in a terminal | One installer file; the person picks the allowed folders | Use the app's Code tab (Claude Code) or Cowork, which work in folders the person picks, under their own settings |
| 📏 **One rule set across AI tools** | Security reviews one policy, not one per tool | The same folder limit and command blocklist for this server in Claude Code, Claude Desktop, Codex and VS Code; its file and settings tools cannot loosen them, but the commands it runs are not sandboxed | Each tool has its own permission settings to set and review (Claude Code managed settings, Codex requirements, VS Code approvals) |
| 🔁 **Sessions that stay open** | SSH triage, REPLs and log tails need state between turns | Sessions stay open and the agent types into them; lines typed into a shell or SSH session are checked against the blocklist (REPL input is not). Plain pipes: no password prompts or full-screen programs | Codex and VS Code can type into a running terminal; Claude Code runs each command in its own process |
| 🧾 **A supply chain you can audit** | Every tool on a seat needs an owner and a trail | Signed dependency register, npm provenance, owner approval before each release, no telemetry | Any other server you add needs the same review: provenance, a dependency list, an owner |

**Footprint:** 2 direct runtime dependencies (MCP SDK, zod; every package they pull in is in the dependency register), 1,562 lines of server code, nothing to host, and a release is one tag plus one owner approval.
</details>

## 🧩 Clients and platforms

| Client | Install | macOS | Linux | Windows |
|---|---|:-:|:-:|:-:|
| Claude Code — plugin (server + 6 skills) | `/plugin install` above | ✓ | ✓ | ✓ ¹ |
| Claude Code — server only | `claude mcp add` | ✓ | ✓ | ✓ ¹ |
| Claude Desktop | `.mcpb` from [Releases](https://github.com/1xOps/command-center/releases) | ✓ | | ✓ ¹ |
| OpenAI Codex CLI | `codex mcp add` | ✓ | ✓ | ✓ ¹ |
| VS Code (agent mode) | `.vscode/mcp.json` | ✓ | ✓ | ✓ ¹ |

Node.js 24 or later (Claude Desktop installs it from the `.mcpb`). 20 tools — see [`mcp-server/README.md`](mcp-server/README.md#-tools-20).
¹ Windows: 73 of 74 tests pass on GitHub-hosted Windows, 0 fail, 1 POSIX-only ssh test skipped ([run 43794268200](https://github.com/1xOps/command-center/actions/runs/43794268200), 2026-11-16). Timed client installs on Windows are not yet measured.

<details>
<summary><b>⚙️ Install for each client (pinned to 0.4.2)</b></summary>

Replace `/path/to/project` with the folders the agent may use; they become `allowedDirectories` for that session.

> **The plugin passes no folder.** With no folder and an empty `allowedDirectories` there is **no folder limit**. Set `allowedDirectories` in `~/.command-center/config.json`, or use a server-only install with a folder.

```bash
# Claude Code, server only
claude mcp add command-center -- npx -y @1xops/command-center@0.4.2 /path/to/project

# OpenAI Codex CLI
codex mcp add command-center -- npx -y @1xops/command-center@0.4.2 /path/to/project
```

**VS Code** — `.vscode/mcp.json`:
```json
{ "servers": { "command-center": { "type": "stdio", "command": "npx", "args": ["-y", "@1xops/command-center@0.4.2", "${workspaceFolder}"] } } }
```

**Claude Desktop** — open `command-center-0.4.2.mcpb` from [Releases](https://github.com/1xOps/command-center/releases); it asks which folders Command Center may use.
</details>

<details>
<summary><b>🏢 Team configuration (one pinned setup for every seat)</b></summary>

Claude Code — commit `.mcp.json` at the project root:
```json
{ "mcpServers": { "command-center": { "command": "npx", "args": ["-y", "@1xops/command-center@0.4.2", "."] } } }
```

Codex — `~/.codex/config.toml`:
```toml
[mcp_servers.command-center]
command = "npx"
args = ["-y", "@1xops/command-center@0.4.2", "/path/to/project"]
```

Check where a build came from: `npm view @1xops/command-center@0.4.2 dist.attestations` (npm provenance from the CI release).
</details>

<details>
<summary><b>📦 Container (a real boundary for the host)</b></summary>

Non-root user; sees only the mounted folder. Build from a checkout of this repo:
```bash
docker build -t command-center:0.4.2 mcp-server
claude mcp add command-center -- docker run -i --rm --network none -v "/path/to/project:/workspace" command-center:0.4.2
```
`--network none` cuts network access for untrusted work; drop it if sessions need the network.
</details>

<details>
<summary><b>🛡️ Security model</b></summary>

Command Center runs commands with **your** permissions and trusts the AI client driving it. It does not detect prompt injection.

| Control | What it does | Security boundary? |
|---|---|---|
| `allowedDirectories` | Every file tool and session working folder must be inside these folders (symlinks resolved first). Empty = no limit | No |
| `blockedCommands` | Refuses listed programs wherever they start a command, incl. after `;` `&&` `\|` `$(…)`, `sh -c`, `env`/`timeout` wrappers; always refuses `eval` / `Invoke-Expression`. Defaults include `sudo`, `dd`, `mount`, `diskpart`, `reg` | No |
| Person-only settings | `set_config_value` refuses `allowedDirectories`, `blockedCommands`, `defaultShell`; file tools refuse the config folder | No |
| Container | Non-root, only the mounted folder visible | **Yes**, for the host filesystem |

**Limits:** a program started in a session can reach any path and network you can, and could edit the config file (it applies at the next start). The command check reads command lines (including lines typed into a shell or `ssh` session), not scripts or REPL input. Each session keeps its last 1 MiB of output in memory.

**Privacy:** no telemetry, analytics, update checks or remote calls. See [SECURITY.md](mcp-server/SECURITY.md) · [PRIVACY.md](mcp-server/PRIVACY.md).
</details>

## 📁 In this repository

| Folder | What it is |
|---|---|
| [`mcp-server/`](mcp-server/README.md) | npm package `@1xops/command-center`: server, tests, Claude Desktop bundle, container |
| [`plugins/command-center/`](plugins/command-center/README.md) | Claude Code plugin: the pinned server plus six skills |
| [`docs/supply-chain/register.md`](docs/supply-chain/register.md) | Every shipped package and its licence, signed by the owner |

MCP Registry `io.github.1xOps/command-center` · Apache-2.0 © 2026 1xOps · Report vulnerabilities privately: [SECURITY.md](mcp-server/SECURITY.md)
