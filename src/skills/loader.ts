/**
 * SKILL.md frontmatter loader.
 *
 * Parses Markdown files delimited by `---` YAML frontmatter.
 * Returns the extracted metadata and the remaining body content.
 */

export interface SkillParsed {
  name: string;
  description: string;
  content: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a simple single-level YAML block (key: value lines).
 * Only handles flat scalar values — sufficient for SKILL.md frontmatter.
 */
function parseSimpleYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

/**
 * Parse a SKILL.md file's raw text.
 *
 * Expects the file to start with YAML frontmatter delimited by `---`.
 * Extracts `name` and `description` from the frontmatter and returns
 * the rest of the file as `content`.
 */
export function parseSkillMd(raw: string): SkillParsed {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error('SKILL.md missing frontmatter (--- delimiters)');
  }

  const meta = parseSimpleYaml(m[1]);
  const name = meta.name;
  const description = meta.description ?? '';

  if (!name) {
    throw new Error('SKILL.md frontmatter missing required "name" field');
  }

  return { name, description, content: m[2] };
}
