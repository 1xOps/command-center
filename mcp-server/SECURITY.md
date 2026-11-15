# Security

## Security model

Command Center lets an AI client you authorise run commands and read and write text files on your machine, with your permissions. Treat it as an **amplifier of whatever the connected client asks it to do**. It assumes that client, and the account driving it, are trusted. It does not try to detect prompt injection or a compromised account.

## What the controls do

| Control | What it does | Is it a security boundary? |
|---|---|---|
| `allowedDirectories` (config file or launch folders) | Every file tool and every session's working directory must be inside these folders; symlinks and junctions are resolved before the check | No |
| `blockedCommands` | Refuses listed programs where they start a command, including after `;`, `&&`, `\|`, `$(…)`, `sh -c`, `cmd /c`, `powershell -Command` and `env`/`timeout`/`nice` wrappers; case-insensitive, `.exe` ignored; refuses `eval` and `Invoke-Expression` | No |
| Security settings are person-only | `set_config_value` cannot change `allowedDirectories`, `blockedCommands` or `defaultShell` | No |
| Container (`mcp-server/Dockerfile`) | Non-root user; the server sees only the mounted folder | **Yes**, for the host filesystem |

The first three are guardrails against mistakes. A program started in a session can reach any path you can reach, and so can a script file or another interpreter (`python3 -c …`). For untrusted code or a prompt-injection risk, run the container, a VM or a separate machine.

## Known limits

- The command check reads the command line, not the programs it starts. It does not inspect script files or code typed into a REPL.
- Each session keeps the last 1 MiB of output in memory. Secrets printed by a command are visible to the client.
- There is no network control: a command can reach any network you can.

## Supply chain

The server ships two packages: the official MCP SDK and zod (its required peer), plus their own dependencies, all MIT, ISC or BSD licensed. The list is generated from `npm sbom` into `docs/supply-chain/register.md` by `task mcp:supply-chain`. CI fails on an unregistered package or licence, and a release fails until the owner signs every entry. npm releases carry build provenance.

## Reporting a vulnerability

Use GitHub private vulnerability reporting (repository Security tab, "Report a vulnerability") at https://github.com/1xOps/command-center-mcp, or email the owner, nnthanh101 (nnthanh101@gmail.com). Please include steps to reproduce. We acknowledge reports, assess impact and publish fixed versions with an advisory.
