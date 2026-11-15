---
name: computer-health-check
description: Runs a read-only health check of the person's computer on macOS, Linux or Windows (disk, memory, CPU, battery, pending updates, startup items) and reports each finding with the number and command behind it. Use when the person says the computer is slow, full, hot or unstable, or asks for a health check or what is using the disk or memory.
---

# Computer health check

The result is a short report: what was measured, what is wrong, and what to do. Every finding carries a number from a command run in this session.

## Rules

- **Read-only.** Run only commands that report. Deleting files, stopping processes, changing startup items or installing updates needs the person's yes, item by item.
- **Measured, never guessed.** If a check cannot run, the report says so and leaves the gap open.
- **Privacy.** Report process and folder names, never file contents.
- **No elevation.** `sudo` is blocked by `blockedCommands`; a check that needs an administrator is reported as "needs an administrator".

## Steps

1. Find the OS with `command-center:get_config` (`defaultShell`), then read the matching file: [macOS](references/macos.md), [Linux](references/linux.md) or [Windows](references/windows.md).
2. Run each check with `command-center:start_process` (`timeout_ms` 20000), in this order: OS and uptime, disk, memory, CPU, battery, updates, startup items. `command-center:list_processes` (`limit` 10) gives the largest processes on every OS.
3. Judge each result against the thresholds below.
4. Report in this shape:

```
Health check: <OS and version>, <date and time>

| Area | Measured | Status |
|---|---|---|
| Disk (system) | 18 GB free of 494 GB (4%) | act |

Findings
1. <finding>: <number> from `<command>`. Suggested action: <action> (needs your yes).
```

## Thresholds

| Area | Watch | Act |
|---|---|---|
| Free space on the system disk | under 20% | under 10%, or under 15 GB |
| Memory | swap in use and growing | macOS pressure "critical", or under 10% available |
| CPU | one process above 80% for a minute | load above the core count for 5 minutes |
| Battery | capacity under 80%, or "Service" condition | |
| Uptime | over 14 days (updates often wait for a restart) | |
| Updates | any pending security update | |

These are starting points chosen for a laptop or workstation; the person may set their own.

## Follow-ups

- **"What is using my disk?"** Measure the largest folders in the home folder with the command in the OS file, then suggest candidates (caches, old downloads, build output). Delete nothing without a yes per item.
- **"Stop that process."** Confirm the name and pid with `command-center:list_processes` and ask. `command-center:force_terminate` stops only sessions this server started; any other process is the person's to stop.
