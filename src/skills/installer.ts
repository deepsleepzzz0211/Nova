/**
 * Skill installer — clones skill repos into the local skill directory.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { novaHome } from '../config/loader.js';
import * as path from 'path';

/**
 * Extract the repository name from a git URL.
 * Handles HTTPS URLs (https://host/user/repo.git) and SSH URLs (git@host:user/repo.git).
 */
function repoNameFromUrl(gitUrl: string): string {
  const stripped = gitUrl.replace(/\.git$/, '');
  const lastSegment = stripped.split('/').pop() ?? stripped;
  // For SSH-style git@host:user/repo → last segment after ':'
  return lastSegment.includes(':') ? lastSegment.split(':').pop()! : lastSegment;
}

/**
 * Clone a git repository containing skill definitions into the local
 * skill directory (~/.codeagent/skills/{repo-name}).
 *
 * Returns the absolute path of the installed skill directory.
 */
export function installSkill(gitUrl: string): string {
  const repoName = repoNameFromUrl(gitUrl);
  const installDir = path.join(novaHome(), '.nova', 'skills', repoName);

  if (!fs.existsSync(path.dirname(installDir))) {
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
  }

  if (fs.existsSync(installDir)) {
    throw new Error(`Skill already installed: ${installDir}`);
  }

  execSync(`git clone ${JSON.stringify(gitUrl)} ${JSON.stringify(installDir)}`, {
    stdio: 'pipe',
  });

  return installDir;
}
