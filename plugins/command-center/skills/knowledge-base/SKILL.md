---
name: knowledge-base
description: Builds and maintains a folder of plain Markdown notes that people and AI agents both read, with one entry point, one note per topic and relative links. Use when the person wants to start a knowledge base, add or update notes, file decisions, meeting notes or how-tos, answer a question from their notes, or find broken links, orphans and duplicates. For an Obsidian vault, use obsidian-vault as well.
---

# Markdown knowledge base

Plain Markdown files work in every editor, in git and in every AI client, so the base outlives any one tool.

## Layout

Create only the folders the person needs:

```
<base>/
  README.md     entry point: purpose, and a link to each area
  decisions/    one note per decision, named YYYY-MM-DD-short-title.md
  how-to/       task guides with verb-first names, e.g. rotate-api-keys.md
  reference/    facts that change rarely: systems, roles, glossary
  meetings/     YYYY-MM-DD-topic.md
  inbox/        quick captures waiting to be filed
```

## Note shape

```markdown
---
title: Rotate API keys
updated: 2026-11-16
tags: [security, how-to]
---

# Rotate API keys

One paragraph: what this is and when to use it.

## Steps

## Related
- [Secrets policy](../reference/secrets-policy.md)
```

- One topic per note: a note that needs two summaries becomes two notes.
- Lowercase hyphenated file names; dates as YYYY-MM-DD.
- Relative links (`[text](../path.md)`), so they work on GitHub and in any editor.
- The answer first, background after.
- No secrets, passwords or personal data.

## Workflows

**Start a base.** `command-center:create_directory` for each folder, then `command-center:write_file` for `README.md`. Content longer than `fileWriteLineLimit` lines goes in chunks: the first with `mode` "rewrite", the rest with "append".

**Add a note.** Search first so you don't create a duplicate: `command-center:search` with the topic words (`ignore_case` true), and again with `kind` "files". Update an existing note with `command-center:edit_block`; otherwise write a new one and link it from `README.md` or its area.

**File the inbox.** Move each capture with `command-center:move_file`, then fix links to its old name (find them with `command-center:search`).

**Answer from the base.** Search, read the matches with `command-center:read_multiple_files`, and answer citing note paths. If the base has no answer, say so before adding anything from general knowledge.

**Check the base.** Report first; fix only on the person's yes:
- broken links: each `](….md)` target that `command-center:get_file_info` cannot find;
- orphans: notes no other note links to;
- stale notes: `updated` over a year ago on a topic that changes;
- duplicates: notes with near-identical titles.

## Limits

- Only folders inside `allowedDirectories`. For a base elsewhere, ask the person to allow it.
- PDFs, Office files and images are read by the client's own document features; link to them from notes.
