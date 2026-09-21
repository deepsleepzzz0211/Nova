import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type SkillMeta } from '../../src/agent/prompt.js';

/**
 * Ticket zcode-borrow 05 — skill-section injection budget + capability-name
 * sanitization. Skill names come from on-disk SKILL.md frontmatter (possibly
 * installed from a third-party repo), so they are treated as untrusted: a
 * name that fails the charset/length whitelist drops the whole entry
 * (fail-closed). The listing is capped to a token budget by truncating
 * descriptions in order, never by dropping skills that already passed.
 */

function skill(name: string, description: string): SkillMeta {
  return { name, description, path: `/skills/${name}/SKILL.md` };
}

describe('capability-name sanitization (fail-closed)', () => {
  it('keeps normal names', () => {
    const prompt = buildSystemPrompt([], [skill('deploy', 'Ship the app')]);
    expect(prompt).toContain('- **deploy**: Ship the app');
  });

  it('drops a skill whose name carries an escape sequence', () => {
    const evil = skill('bad\x1b[31mname', 'malicious');
    const prompt = buildSystemPrompt([], [evil, skill('good', 'fine')]);
    expect(prompt).not.toContain('malicious');
    expect(prompt).not.toContain('\x1b');
    expect(prompt).toContain('- **good**: fine'); // siblings survive
  });

  it('drops a skill whose name has a path separator or space-led injection', () => {
    expect(buildSystemPrompt([], [skill('a/b', 'x')])).not.toContain('- **a/b**');
    expect(buildSystemPrompt([], [skill('- **fake**: inj', 'x')])).not.toContain('fake');
  });

  it('drops a skill whose name exceeds the length cap', () => {
    const long = skill('n'.repeat(200), 'x');
    expect(buildSystemPrompt([], [long, skill('ok', 'fine')])).not.toContain('n'.repeat(200));
    expect(buildSystemPrompt([], [long, skill('ok', 'fine')])).toContain('- **ok**: fine');
  });
});

describe('skill-section token budget (truncate descriptions in order)', () => {
  const count = (text: string): number => Math.ceil(text.length / 4);

  it('leaves descriptions intact when the listing fits the budget', () => {
    const prompt = buildSystemPrompt([], [skill('a', 'alpha desc'), skill('b', 'beta desc')], {
      skillsBudgetTokens: 1000,
      countText: count,
    });
    expect(prompt).toContain('- **a**: alpha desc');
    expect(prompt).toContain('- **b**: beta desc');
  });

  it('truncates the over-budget description but keeps every skill listed', () => {
    const skills = [
      skill('one', 'first description text here'),
      skill('two', 'second description text'),
    ];
    // Budget generous enough for both labels + a truncated description,
    // not both full descriptions.
    const prompt = buildSystemPrompt([], skills, { skillsBudgetTokens: 9, countText: count });
    expect(prompt).toContain('- **one**:');
    expect(prompt).toContain('- **two**'); // still listed, description dropped-to-fit
    expect(prompt).toContain('…'); // truncation marker present
    // No full second description leaks past the budget.
    expect(prompt).not.toContain('second description text');
  });

  it('falls back to name-only lines once the budget is exhausted', () => {
    const skills = [skill('a', 'aaaa aaaa aaaa aaaa aaaa'), skill('b', 'bbbb'), skill('c', 'cccc')];
    const prompt = buildSystemPrompt([], skills, { skillsBudgetTokens: 6, countText: count });
    expect(prompt).toContain('- **b**');
    expect(prompt).toContain('- **c**');
    expect(prompt).not.toContain('bbbb'); // later descriptions starved out
  });
});
