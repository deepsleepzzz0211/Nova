import { describe, it, expect } from 'vitest';
import { evaluateAudit, extractHighFindings } from '../../scripts/audit-deps.mjs';

// p1-p2 07 (report-15): dev dependencies join the audit, and waivers are
// recorded (reason + expiry) instead of the old binary "ignore all dev".
// evaluateAudit is the pure judgement over a normalized findings list;
// extractHighFindings normalizes pnpm's --json shape (fail-closed on junk).

interface Finding { id: string; module: string; severity: string }
const f = (id: string, module = 'evil-pkg', severity = 'high'): Finding => ({ id, module, severity });
const waiver = (id: string, expires: string) => ({ id, reason: 'assessed 2026-09-26: not reachable', expires });

describe('evaluateAudit (p1-p2 07)', () => {
  it('passes a clean findings list', () => {
    const r = evaluateAudit({ findings: [], waivers: [], today: '2026-09-26' });
    expect(r.blocked).toEqual([]);
  });

  it('blocks an unwaived high finding', () => {
    const r = evaluateAudit({ findings: [f('GHSA-aaaa-bbbb-cccc')], waivers: [], today: '2026-09-26' });
    expect(r.blocked.map((b: Finding) => b.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('waives a matching, unexpired advisory', () => {
    const r = evaluateAudit({
      findings: [f('GHSA-aaaa-bbbb-cccc')],
      waivers: [waiver('GHSA-aaaa-bbbb-cccc', '2026-12-31')],
      today: '2026-09-26',
    });
    expect(r.blocked).toEqual([]);
    expect(r.waived.map((w: { id: string }) => w.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('an EXPIRED waiver does not waive (that is the whole point)', () => {
    const r = evaluateAudit({
      findings: [f('GHSA-aaaa-bbbb-cccc')],
      waivers: [waiver('GHSA-aaaa-bbbb-cccc', '2026-09-25')],
      today: '2026-09-26',
    });
    expect(r.blocked.map((b: Finding) => b.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('waiver id must match exactly (no prefix drift)', () => {
    const r = evaluateAudit({
      findings: [f('GHSA-aaaa-bbbb-ccdd')],
      waivers: [waiver('GHSA-aaaa-bbbb-cccc', '2026-12-31')],
      today: '2026-09-26',
    });
    expect(r.blocked).toHaveLength(1);
  });
});

describe('extractHighFindings (p1-p2 07)', () => {
  it('keeps only high/critical severities from a pnpm-shaped report', () => {
    const report = {
      advisories: {
        'GHSA-hi-hi-hi': { module_name: 'a', severity: 'high', github_advisory_id: 'GHSA-hi-hi-hi' },
        'GHSA-mo-mo-mo': { module_name: 'b', severity: 'moderate', github_advisory_id: 'GHSA-mo-mo-mo' },
        'GHSA-cr-cr-cr': { module_name: 'c', severity: 'critical', github_advisory_id: 'GHSA-cr-cr-cr' },
      },
    };
    const ids = extractHighFindings(report).map((x: Finding) => x.id).sort();
    expect(ids).toEqual(['GHSA-cr-cr-cr', 'GHSA-hi-hi-hi']);
  });

  it('fail-closed: an unrecognized report shape is itself a blocker', () => {
    expect(() => extractHighFindings({ nonsense: true })).toThrow(/unrecognized|unparse/i);
  });
});
