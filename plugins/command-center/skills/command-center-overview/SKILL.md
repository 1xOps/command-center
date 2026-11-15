---
name: command-center-overview
description: Explains what the 1xOps Command Center MCP server can and cannot do and picks the right tool: persistent shell, REPL or SSH sessions across turns, long builds and servers read later, text-file reading and editing in allowed folders, code search, paged search and the system process list. Use when work needs these tools or the person asks what Command Center is.
---

# Command Center overview

Command Center is a local MCP server. It gives the agent **persistent sessions** (shells, REPLs, SSH, servers, test runs) and **text-file tools** inside the folders a person allowed, with one command blocklist. It runs on the user's machine with the user's permissions and sends nothing anywhere.

## When to use it, and when not

| Need | Use |
|---|---|
| A command whose output arrives over minutes (tests, builds, `tail -f`, a dev server) | `command-center:start_process`, then `command-center:read_process_output` |
| State that must survive between turns (a Python REPL with data loaded, an SSH session, a database shell) | `command-center:start_process` + `command-center:interact_with_process` |
| Read, write or patch a text file | `command-center:read_file`, `command-center:write_file`, `command-center:edit_block` |
| Find call sites or files in a tree | `command-center:search`; thousands of results: `command-center:start_search`, then `command-center:get_more_search_results` page by page |
| What is running on the machine | `command-center:list_processes` |
| PDF, Word, Excel, PowerPoint, images to analyse | the client's own document features (Claude reads PDFs and images; `document-skills` handle Office files). Command Center returns images as-is and refuses other binary files. |
| Web pages or APIs | the client's web tools, or a command such as `curl` through `command-center:start_process` |

## Patterns

**Run the tests and summarise failures.** `command-center:start_process(command="npm test", timeout_ms=10000)` returns the first output and a `pid`. While `running` is true, call `command-center:read_process_output(pid, timeout_ms=30000)` until it reports the exit code. Summarise from the output, not from memory.

**Work in a REPL.** `command-center:start_process("python3 -i")` (or `node -i`), then `command-center:interact_with_process(pid, "import pandas as pd; df = pd.read_csv('/abs/data.csv'); df.describe()")`. The interpreter keeps `df` for later turns. Use `-i`: without a terminal, Python and Node only show prompts in interactive mode.

**SSH.** `command-center:start_process("ssh -o BatchMode=yes host")`, then send commands with `command-center:interact_with_process`. Password prompts cannot be answered safely by an agent; use keys or ask the person.

**Read logs.** `command-center:read_file(path, offset=-200)` returns the last 200 lines. For files over 64 MB, use `command-center:start_process("tail -n 200 /abs/file.log")` or `grep`.

**Patch code.** `command-center:read_file` the region first, then `command-center:edit_block(file_path, old_string, new_string)` with enough surrounding lines to be unique. If the text is not found, nothing changes and the reply shows the closest passage; retry with the file's real text. Set `expected_replacements` to change every occurrence on purpose.

**Write a large file.** `command-center:write_file` accepts up to `fileWriteLineLimit` lines (default 50) per call: write the first chunk with `mode="rewrite"`, then the rest with `mode="append"`.

**Explore a repository.** `command-center:list_directory(path, depth=2)` for shape, `command-center:search(path, pattern="export function", glob="*.ts")` for code, `command-center:search(path, pattern="README", kind="files")` for names.

**Clean up.** `command-center:list_sessions` shows every session and its unread output; `command-center:force_terminate(pid)` stops a session and its children.

## Limits the agent must respect

- **Paths.** Every path must be inside `allowedDirectories`. A refusal names the setting; do not try other paths to get round it. Ask the person.
- **Commands.** `blockedCommands` (for example `sudo`, `dd`, `mount`) is refused at the start of any command and inside interactive shells; `eval` is refused. This is a guardrail, not a sandbox.
- **Settings.** `command-center:set_config_value` changes only `fileReadLineLimit` and `fileWriteLineLimit`. `allowedDirectories`, `blockedCommands` and `defaultShell` are changed only by a person, in `~/.command-center/config.json`.
- **Output.** Each session keeps the last 1 MiB of output; older output is dropped and the result says so.

## Tools (20)

- **Processes:** `command-center:start_process`, `command-center:interact_with_process`, `command-center:read_process_output`, `command-center:force_terminate`, `command-center:list_sessions`
- **Files:** `command-center:read_file`, `command-center:read_multiple_files`, `command-center:write_file`, `command-center:edit_block`, `command-center:list_directory`, `command-center:get_file_info`, `command-center:create_directory`, `command-center:move_file`
- **Search:** `command-center:search`; for large result sets `command-center:start_search`, `command-center:get_more_search_results`, `command-center:stop_search`
- **System:** `command-center:list_processes` (read-only)
- **Settings:** `command-center:get_config`, `command-center:set_config_value`
