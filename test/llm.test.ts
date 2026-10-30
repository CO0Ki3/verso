import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const read = (path: string): string => readFileSync(join(import.meta.dirname, '..', path), 'utf8');

it('ships the Claude Code skill as LLM.md, word for word without its frontmatter', () => {
  const skill = read('claude-plugin/skills/type-tests/SKILL.md');
  const body = skill.slice(skill.indexOf('\n---\n', 4) + '\n---\n'.length).trimStart();
  expect(read('LLM.md')).toBe(body);
});
