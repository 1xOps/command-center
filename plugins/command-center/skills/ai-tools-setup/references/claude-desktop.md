# Claude Desktop and Command Center

## Recommended: the bundle

1. Download `command-center-0.4.0.mcpb` from the GitHub release of `1xOps/command-center-mcp`.
2. Open it (double-click, or Settings → Extensions → Install extension).
3. Pick the folders Command Center may use. Claude Desktop passes each one as a launch argument.
4. In a new chat, ask for `get_config`: it lists the folders you picked.

The bundle carries its own copy of the server, so no `npx` or registry access is needed at run time. Claude Desktop runs it with its built-in Node.

## Manual: the config file

| OS | File |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "command-center": {
      "command": "npx",
      "args": ["-y", "@1xops/command-center@0.4.0", "/Users/me/work"]
    }
  }
}
```

- On Windows, write folders as `"C:\\Users\\me\\work"` (escaped backslashes) and use `"command": "npx.cmd"` if `npx` is not found.
- On macOS, if Claude Desktop cannot find `npx`, set `command` to the absolute path from `which npx`.
- Quit Claude Desktop fully (not just close the window) and start it again after each change.

## Logs

| OS | Folder |
|---|---|
| macOS | `~/Library/Logs/Claude/` (`mcp-server-command-center.log`) |
| Windows | `%APPDATA%\Claude\logs\` |

Read the last lines with `read_file(path, offset=-100)` when that folder is allowed, or ask the person to open it. Command Center writes its own messages to stderr, which these logs capture.
