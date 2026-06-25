/**
 * Skill resolver — thin convenience layer over SkillRegistry.
 *
 * Re-exports the registry and its types so callers can import from
 * a single "resolver" module when they only need resolution logic.
 */

export { SkillRegistry } from './registry.js';
export type { SkillMeta } from './registry.js';
