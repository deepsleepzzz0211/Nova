/**
 * Session lifecycle at startup (p1-p2 10, split out of index.tsx):
 * retention sweeps, --list, --resume (interactive picker), the
 * shadow-replay conservation gate, and creation of the live session store.
 * The exits (--list / --replay-sessions) keep their original position in
 * startup order so side effects are unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { novaHome } from '../config/loader.js';
import { SessionStore, SESSION_RETENTION_DAYS } from '../agent/session.js';
import type { SessionSummary } from '../agent/session.js';
import { SessionPicker, formatSessionList } from '../tui/SessionPicker.js';
import { replaySessionFile, replaySessionsDir } from '../agent/shadow-replay.js';
import type { Message } from '../llm/types.js';
import type { CliValues } from './args.js';

export interface SessionStartup {
  initialHistory: Message[];
  sessionStore: SessionStore;
  subagentsDir: string;
}

export async function runSessionStartup(values: CliValues): Promise<SessionStartup> {
  const sessionsDir = path.join(novaHome(), '.nova', 'sessions');
  const sweepAndReport = (dir: string, label: string): void => {
    const swept = SessionStore.sweep(dir, SESSION_RETENTION_DAYS);
    if (swept > 0) console.error(`[${label}] removed ${swept} stale file(s) older than ${SESSION_RETENTION_DAYS} days`);
  };
  sweepAndReport(sessionsDir, 'sessions');
  const subagentsDir = path.join(novaHome(), '.nova', 'subagents');
  sweepAndReport(subagentsDir, 'subagents');

  if (values.list) {
    const sessions = SessionStore.listSummaries(sessionsDir);
    console.log(formatSessionList(sessions));
    process.exit(0);
  }

  // Shadow-replay conservation gate (zcode-borrow 06): replay every stored
  // session offline through the deterministic context pipeline and assert no
  // silent message loss. Read-only; exits non-zero on any violation so it can
  // gate a release.
  if (values['replay-sessions']) {
    const projectDir = process.cwd();
    const positional = Array.isArray(values._) ? values._[0] : undefined;
    const target = typeof positional === 'string'
      ? path.resolve(projectDir, positional)
      : sessionsDir;
    const isFile = fs.existsSync(target) && fs.statSync(target).isFile();
    const reports = isFile ? [replaySessionFile(target)] : replaySessionsDir(target);
    if (reports.length === 0) {
      console.log(`no sessions to replay in ${target}`);
      process.exit(0);
    }
    let violations = 0;
    for (const report of reports) {
      const name = path.basename(report.file);
      if (report.conserved) {
        console.log(
          `OK   ${name}: ${report.loaded} msgs -> ${report.final} msgs ` +
            `(cleared ${report.clearedToolResults} tool results, dropped ${report.droppedMessages})`,
        );
      } else {
        violations++;
        console.log(`FAIL ${name}: ${report.error ?? 'conservation violated'}`);
      }
    }
    console.error(`\n${reports.length - violations}/${reports.length} sessions conserved`);
    process.exit(violations > 0 ? 1 : 0);
  }

  let initialHistory: Message[] = [];
  if (values.resume) {
    const sessions = SessionStore.listSummaries(sessionsDir);
    if (sessions.length === 0) {
      console.error('No previous sessions found in', sessionsDir);
    } else {
      let picked: SessionSummary | null = sessions[0]; // default: latest (previous behavior)
      if (sessions.length > 1 && process.stdin.isTTY) {
        picked = await new Promise<SessionSummary | null>((resolve) => {
          const { waitUntilExit } = render(
            <SessionPicker sessions={sessions} defaultIndex={0} onPick={resolve} />,
          );
          void waitUntilExit();
        });
      }
      if (!picked) {
        console.error('Resume cancelled.');
        process.exit(0);
      }
      initialHistory = SessionStore.load(picked.file);
    }
  }

  return { initialHistory, sessionStore: SessionStore.create(sessionsDir), subagentsDir };
}
