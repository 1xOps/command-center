# 1xOps Command Center

**Before your AI starts a job, know that every connector is signed in to the right account, with the right access.**

Claude Code shows a connector as "✔ Connected" when its server starts. That doesn't mean its credentials work, or that it uses the account the job needs. On one Mac on 2026-11-16, `claude mcp list` showed three AWS connectors as "✔ Connected" while none of them had working AWS credentials ([evidence](docs/evidence/darwin-2026-11-16.json)). Command Center asks each vendor's own CLI who the connector is signed in as, and tells you before work starts.

## Who uses it, and how

| You are | You run | You get |
|---|---|---|
| Cloud & infrastructure engineer, SRE, developer | `npx @1xops/command-center check` (once 1.0.0 is published; until then `node cli/bin/command-center.mjs check`) | One line per connector: account, profile, access (read or write), expiry, and OK, WARN or FAIL with the reason |
| Anyone using Claude Code | the SessionStart hook below | Claude starts every session already knowing which connectors are broken, and tells you instead of failing halfway through a job |
| A team that needs read-only work | a `.command-center.json` in the project | A FAIL on the wrong AWS account, and a WARN when a token can write but the job only reads |

```json
// ~/.claude/settings.json: every Claude Code session starts with the check
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "npx -y @1xops/command-center@1 check --brief || true" } ] } ] } }
```

```json
// .command-center.json: what this project's jobs need (${VAR} reads the environment)
{ "aws": { "account": "${AWS_ACCOUNT_ID}", "access": "read" }, "github": { "access": "read" } }
```

Exit code: `0` all OK, `1` a warning, `2` a failure. Add `--json` for scripts.

## What it checks today

| Connector | Found in | Identity call (read-only) | Reports |
|---|---|---|---|
| AWS (awslabs servers, `mcp-proxy-for-aws`, any server with `AWS_PROFILE`) | Claude Code user, folder and plugin config; Codex `config.toml` | `aws sts get-caller-identity` (needs no permission); `aws configure export-credentials`, from which only the expiry is kept | account (last 4 digits), role, access read/write/unknown, expiry; an unset `${VAR}` or plugin setting is named |
| GitHub (`api.githubcopilot.com/mcp`, `github-mcp-server`) | same | `gh auth status --json hosts` | login, scopes, access read/write |
| Anything else | same | none yet | listed as `—`, never as OK |

Access is judged from the AWS role or permission-set name (ReadOnly, ViewOnly, SecurityAudit = read; Admin, PowerUser, FullAccess = write). Any other name is `unknown`, and `unknown` is never OK for a read-only job. Command Center never prints or stores a token, and shows only the last 4 digits of an account.

**Not a security control.** It checks and reports. Enforcement stays with your credentials (use read-only roles) and with each app's own settings.

## Develop

Node 24, no dependencies.
- `task check` runs the tests (22, covering the six setups: missing profile, expired sign-in, wrong account, write scopes on a read-only job, revoked token, healthy).
- `task connectors` checks this machine.
- `task evidence` writes the side-by-side JSON.

## Earlier versions

0.4.x was an MCP server with terminal and file tools. Claude Code and Codex already ship those tools, so it was removed. Its source is at the tag `command-center-v0.4.2`.

Apache-2.0 · 1xOps
