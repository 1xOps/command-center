# 1xOps Command Center

An MCP server that gives Claude and OpenAI agents **persistent terminal sessions** (tests, builds, logs, REPLs, SSH) and **text-file tools**, limited to the folders a person allows, with one command blocklist. It runs on your machine with your permissions and sends nothing anywhere.

- **Clients:** Claude Code, Claude Desktop, OpenAI Codex CLI, VS Code, and any other MCP client that starts a stdio server.
- **Platforms:** macOS, Linux and Windows. macOS and Linux are tested locally before each push; all three run in CI on every release pull request to `main`.
- **Requires:** Node.js 24 or later (Claude Code, Codex). Claude Desktop installs it from one file.
- **Package:** `@1xops/command-center` · MCP Registry name `io.github.1xOps/command-center` · Apache-2.0.

## Install (always pin the version)

Replace `/path/to/project` with the folders the agent may use. Folders given at launch become `allowedDirectories` for that session.

**Claude Code: plugin (server plus usage skills)**

```
/plugin marketplace add 1xOps/command-center
/plugin install command-center@command-center
```

**Claude Code: server only**

```bash
claude mcp add command-center -- npx -y @1xops/command-center@0.4.0 /path/to/project
```

**OpenAI Codex CLI**

```bash
codex mcp add command-center -- npx -y @1xops/command-center@0.4.0 /path/to/project
```

**VS Code (agent mode):** add to `.vscode/mcp.json`:

```json
{ "servers": { "command-center": { "type": "stdio", "command": "npx", "args": ["-y", "@1xops/command-center@0.4.0", "${workspaceFolder}"] } } }
```

On Windows, if a client cannot start `npx`, use `"command": "npx.cmd"`.

**Claude Desktop (macOS, Windows):** download `command-center-0.4.0.mcpb` from the [release](https://github.com/1xOps/command-center/releases) and open it. The installer asks which folders Command Center may use.

**Container (any OS with Docker):** it sees only the folder you mount.

```bash
docker build -t command-center:0.4.0 mcp-server
claude mcp add command-center -- docker run -i --rm -v "/path/to/project:/workspace" command-center:0.4.0
```

## Team configuration (one approved setup for every seat)

Commit this to the project as `.mcp.json` (Claude Code). Every engineer then runs the same pinned version with the same folders:

```json
{
  "mcpServers": {
    "command-center": {
      "command": "npx",
      "args": ["-y", "@1xops/command-center@0.4.0", "."]
    }
  }
}
```

The Codex equivalent, in `~/.codex/config.toml`:

```toml
[mcp_servers.command-center]
command = "npx"
args = ["-y", "@1xops/command-center@0.4.0", "/path/to/project"]
```

Check what a seat runs with `npm view @1xops/command-center@0.4.0 dist.attestations`. It shows the build provenance npm recorded at publish.

## Tools (20)

| Area | Tools |
|---|---|
| Processes | `start_process`, `interact_with_process`, `read_process_output`, `force_terminate`, `list_sessions` |
| Files (text; images returned as images) | `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `list_directory`, `get_file_info`, `create_directory`, `move_file` |
| Search (ripgrep when installed) | `search`; for large result sets, paged: `start_search`, `get_more_search_results`, `stop_search` (up to 10 kept, each freed 10 minutes after its last read) |
| System (read-only) | `list_processes`: the OS process list with memory, on macOS, Linux and Windows |
| Settings | `get_config`, `set_config_value` |

PDF, Word, Excel and PowerPoint files are handled by the official document skills: `pdf`, `docx`, `xlsx` and `pptx` from Anthropic's skills repository. They work in Claude and, as Agent Skills, in Codex (`.agents/skills`). Each lists the tools it needs, for example LibreOffice or Python packages.

## Settings

Settings live in `~/.command-center/config.json` (on Windows, `%USERPROFILE%\.command-center\config.json`). The file is created with defaults on first start.

| Key | Purpose | Who can change it |
|---|---|---|
| `allowedDirectories` | Folders every file tool and working directory must be inside. Folders given at launch override this. **Empty means no folder limit.** | a person only |
| `blockedCommands` | Programs refused wherever they start a command (defaults include `sudo`, `dd`, `mount`, `diskpart`, `reg`) | a person only |
| `defaultShell` | Shell for sessions (default: your login shell; PowerShell on Windows) | a person only |
| `fileReadLineLimit` | Lines per `read_file` (default 1000) | person or agent |
| `fileWriteLineLimit` | Lines per `write_file` call (default 50) | person or agent |

An agent cannot widen its own access: `set_config_value` refuses the first three keys.

## Security

Command Center runs commands with your permissions. `allowedDirectories` and `blockedCommands` are guardrails against mistakes, **not a sandbox**: a program started in a session can reach anything you can. For untrusted work, use the container. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm test                    # build + all tests (node:test)
task setup                  # once per clone: turns on the git-standard hooks
task check                  # every local gate before the owner commits develop
task mcp:verify             # from the repo root: timed end-to-end check with evidence
task mcp:act                # the real CI workflow's macOS job on this Mac (act, no runner image)
task mcp:ci-local           # the Linux CI job in the pinned Wolfi image
task mcp:supply-chain       # SBOM and the signed dependency register
task mcp:release-rehearsal  # what would be published, publishing nothing
```

Releases run in CI from a tag `mcp-server-vX.Y.Z`. They publish only after the owner approves, through the `release` environment (see `.github/workflows/mcp-server-release.yml`).

## Licence

Apache-2.0 © 2026 1xOps (nnthanh101, nnthanh101@gmail.com). See [LICENSE](LICENSE). The npm packages it depends on keep their own licences; the list is in the supply-chain register.
