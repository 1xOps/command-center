// Skills follow Anthropic's Agent Skills authoring rules (platform.claude.com, agent-skills best
// practices): frontmatter with name and description only; name lowercase-hyphen, at most 64
// characters, without reserved words; description in the third person, at most 1024 characters;
// body under 500 lines; references one level deep, with a table of contents over 100 lines;
// forward-slash paths; and this server's tools named as command-center:<tool>.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillsDir = fileURLToPath(new URL('../../plugins/command-center/skills', import.meta.url));
const skills = readdirSync(skillsDir).filter((d) => existsSync(path.join(skillsDir, d, 'SKILL.md')));
const TOOLS = ['start_process', 'interact_with_process', 'read_process_output', 'force_terminate', 'list_sessions', 'read_file',
  'read_multiple_files', 'write_file', 'edit_block', 'list_directory', 'get_file_info', 'create_directory', 'move_file', 'search',
  'start_search', 'get_more_search_results', 'stop_search', 'list_processes', 'get_config', 'set_config_value'];

function parse(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${file} starts with YAML frontmatter`);
  const fields = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { fields, body: m[2] };
}

test('six skills, each with only name and description in its frontmatter', () => {
  assert.equal(skills.length, 6);
  for (const s of skills) {
    const { fields } = parse(path.join(skillsDir, s, 'SKILL.md'));
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'name'], s);
    assert.equal(fields.name, s);
    assert.match(fields.name, /^[a-z0-9-]{1,64}$/);
    assert.doesNotMatch(fields.name, /anthropic|claude/);
  }
});

test('descriptions say what and when, in the third person, within 1024 characters', () => {
  for (const s of skills) {
    const { description } = parse(path.join(skillsDir, s, 'SKILL.md')).fields;
    assert.ok(description.length > 0 && description.length <= 1024, `${s}: ${description.length} characters`);
    assert.doesNotMatch(description, /^(Use |I |You )/, `${s} starts in the third person`);
    assert.match(description, /Use when/, `${s} says when to use it`);
    assert.doesNotMatch(description, /<[a-z]/i, `${s} has no XML tags`);
  }
});

test('bodies stay under 500 lines; references are one level deep and short or indexed', () => {
  for (const s of skills) {
    const dir = path.join(skillsDir, s);
    const { body } = parse(path.join(dir, 'SKILL.md'));
    assert.ok(body.split('\n').length < 500, `${s} body lines`);
    assert.doesNotMatch(body, /\]\([^)]*\\/, `${s} uses forward slashes in links`);
    const refs = path.join(dir, 'references');
    if (!existsSync(refs)) continue;
    for (const r of readdirSync(refs)) {
      const text = readFileSync(path.join(refs, r), 'utf8');
      assert.doesNotMatch(text, /\]\((?!https?:)[^)]*\.md\)/, `${s}/references/${r} links no further file`);
      if (text.split('\n').length > 100) assert.match(text, /## Contents/, `${s}/references/${r} has a table of contents`);
    }
  }
});

test('this server\'s tools are named as command-center:<tool>', () => {
  const bare = new RegExp('`(' + TOOLS.join('|') + ')[(`]');
  for (const s of skills) {
    const { body } = parse(path.join(skillsDir, s, 'SKILL.md'));
    assert.doesNotMatch(body, bare, `${s} names a tool without the command-center: prefix`);
  }
});
