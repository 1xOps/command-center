---
name: terminal
description: Runs command-line work through 1xOps Command Center as persistent sessions — builds, tests, scripts, package managers, git, SSH, database shells and REPLs (python3 -i, node -i) that keep running or keep state between turns — and diagnoses failing commands on macOS, Linux and Windows. Use when the person asks to run a command, start a server or REPL, connect over SSH, or work out why a command failed.
---

# Terminal work with Command Center

Every command runs as a **session** with a `pid`. A session outlives the tool call, so the agent can start something slow, do other work, and come back for the output.

## Choose the call

| Situation | Call |
|---|---|
| Quick command, result needed now | `command-center:start_process(command, timeout_ms=10000)`: the reply has `running: false` and `exitCode` |
| Slow command (install, build, test suite) | `command-center:start_process(command, timeout_ms=5000)`, then `command-center:read_process_output(pid, timeout_ms=30000)` until `running` is false |
| Program that asks questions or holds state | `command-center:start_process` once, then `command-center:interact_with_process(pid, input)` for each line |
| Server or watcher (`npm run dev`, `tail -f`) | `command-center:start_process`, check the first output for "listening" or the error, leave it running, stop it with `command-center:force_terminate` when done |
| What is running on the machine | `command-center:list_processes(filter="node")`; `command-center:list_sessions` shows only the sessions this server started |

Always decide from the exit code and the output text, never from what the command usually prints.

## Shells per OS

- **macOS, Linux:** the shell is `$SHELL` (or `/bin/sh`). Write POSIX commands; quote paths with spaces in single quotes.
- **Windows:** the shell is PowerShell. Use PowerShell syntax (`Get-ChildItem`, `$env:PATH`, `;` between commands); `&&` works only in PowerShell 7 (`pwsh`). For a `cmd` command, run `cmd /c "dir /b"`.
- `command-center:get_config` shows `defaultShell`. Only a person can change it.

## REPLs

- Python: `command-center:start_process("python3 -i")` (Windows: `python -i`). Send one complete statement per `command-center:interact_with_process` call; for a block, send it as one input ending with a blank line.
- Node: `command-center:start_process("node -i")`.
- Database shells: `psql`, `mysql`, `sqlite3 file.db` work the same way. Prefer read-only queries unless the person asked for a change.
- Without `-i`, Python and Node print no prompt when there is no terminal, and the reply looks empty.

## SSH and remote work

- `command-center:start_process("ssh -o BatchMode=yes -o ConnectTimeout=10 user@host")`. `BatchMode` makes a missing key fail fast instead of waiting for a password.
- An agent must never type a password or passphrase. If a prompt asks for one, stop and ask the person to set up a key or an agent.
- Run remote commands with `command-center:interact_with_process`; end with `exit` and confirm the session ended.

## Long output

- Each session keeps the last 1 MiB. A reply marked "older output dropped" lost the beginning: rerun with the output redirected to a file inside an allowed folder (`npm test > /abs/run.log 2>&1`) and read it with `command-center:read_file(path, offset=-200)`.
- Use `grep`, `Select-String` or `command-center:search` on a log rather than reading it all.

## When a command fails

1. Read the whole error, the exit code and the last lines of output.
2. Match the cause:
   - `command not found` / "is not recognized": the tool is missing or not on PATH. Check with `which x` (Windows: `Get-Command x`).
   - `permission denied` / `EACCES` / `Access is denied`: file ownership or permissions; do not reach for elevation.
   - `refused: ... blockedCommands`: Command Center refused it on purpose. Tell the person which command and why; do not rephrase the command to slip past the check.
   - `refused: ... outside allowedDirectories`: the working directory or path is not allowed. Ask the person.
   - `EADDRINUSE` / "address already in use": find the owner with `command-center:list_processes` or `lsof -i :PORT` (Windows: `Get-NetTCPConnection -LocalPort PORT`).
3. Fix one thing, rerun, and report what changed.

## Clean up

Before finishing, call `command-center:list_sessions` and `command-center:force_terminate` every session you started that is no longer needed. `command-center:force_terminate` stops the session's child processes too.
