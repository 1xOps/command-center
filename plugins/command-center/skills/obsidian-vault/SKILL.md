---
name: obsidian-vault
description: Organises an Obsidian vault through its files, without the Obsidian app or a plugin — wikilinks, properties (YAML frontmatter), tags, maps of content, daily notes, attachments and renames that keep links intact. Use when the person mentions Obsidian, a vault, wikilinks or [[links]], MOCs, or wants vault notes tidied, linked or found.
---

# Obsidian vault

An Obsidian vault is a folder of Markdown files plus a `.obsidian/` settings folder. Everything here works on the files, so the app may be open or closed.

## Before changing anything

1. Confirm the vault folder is inside `allowedDirectories` (`command-center:get_config`).
2. Read `.obsidian/app.json` with `command-center:read_file`:
   - `newLinkFormat` ("shortest", "relative" or "absolute") decides how new links are written;
   - `useMarkdownLinks` true means `[text](path.md)` instead of `[[wikilinks]]`;
   - `attachmentFolderPath` is where pasted files go.
3. Never edit other files in `.obsidian/`: they hold the person's app and plugin settings.

## Obsidian syntax

| Element | Form |
|---|---|
| Link | `[[Note name]]`, `[[Note name\|shown text]]`, `[[Note name#Heading]]`, `[[Note name#^block-id]]` |
| Embed | `![[Note name]]`, `![[image.png]]` |
| Properties | YAML frontmatter at the top: `tags`, `aliases`, `created`, plus the person's own keys |
| Tags | `#tag` or `#area/sub-tag` in text, or `tags: [a, b]` in properties |
| Callout | `> [!note] Title` followed by `>` lines |

A wikilink matches a file name without `.md`, anywhere in the vault, unless two files share the name.

## Workflows

**Find notes.** `command-center:search` across the vault: by name with `kind` "files"; by tag with pattern `#project/alpha` (`literal` true); by property with pattern `^status: active`; backlinks to a note with pattern `[[Note name` (`literal` true).

**Create a note.** Check the name is unused, then `command-center:write_file` with properties first. Put it in the folder the person uses for that kind of note, and link it from the relevant map of content.

**Map of content (MOC).** A note that links the notes of one topic, grouped under headings. Build it from search results and order it the way the person thinks about the topic, not alphabetically, unless asked.

**Daily notes.** The folder and date format are in `.obsidian/daily-notes.json` (`folder`, `format`; default `YYYY-MM-DD`). Append with `command-center:write_file` `mode` "append".

**Rename or move a note, keeping links.** Obsidian updates links only when the app performs the rename. Through the files:
1. Find every link to the old name: search `[[Old name` (`literal` true), and `Old%20name.md` if Markdown links are on.
2. Show the person the list and get a yes.
3. `command-center:move_file`, then `command-center:edit_block` each link (`expected_replacements` set to the count in that file).
4. Search again: zero links to the old name remain.

**Tidy.** Report, then fix on the person's yes: notes with no links in or out, links to notes that don't exist, duplicate names in different folders, properties with inconsistent keys (`Tags` and `tags`).

## Limits

- Canvas (`.canvas`) files are JSON: read them and edit only with the person's yes.
- Plugin data in `.obsidian/plugins/` is the plugins' own; read only.
- Images are returned by `command-center:read_file`; PDFs and Office files are read by the client's own document features.
