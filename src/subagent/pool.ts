import type { SubAgent, SubAgentTask, SubAgentResult } from './types.js';
import { DefaultSubAgent } from './default-subagent.js';
import type { AgentLoop } from '../agent/loop.js';

/** Subagent pool for managing multiple subagents. */
export class SubAgentPool {
  private agents: SubAgent[] = [];
  private taskQueue: SubAgentTask[] = [];
  private agentLoopFactory: () => AgentLoop;

  constructor(size: number, agentLoopFactory: () => AgentLoop) {
    this.agentLoopFactory = agentLoopFactory;
    
    for (let i = 0; i < size; i++) {
      const agentLoop = agentLoopFactory();
      const agent = new DefaultSubAgent(`agent-${i}`, agentLoop);
      this.agents.push(agent);
    }
  }

  async executeTasks(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    const promises: Promise<SubAgentResult>[] = [];

    for (const task of tasks) {
      const agent = this.getIdleAgent();
      if (agent) {
        promises.push(
          agent.execute(task).then(result => {
            return result;
          })
        );
      } else {
        this.taskQueue.push(task);
      }
    }

    // Wait for all tasks to complete
    const taskResults = await Promise.all(promises);
    results.push(...taskResults);

    // Process queued tasks
    if (this.taskQueue.length > 0) {
      const remainingResults = await this.executeTasks(this.taskQueue);
      results.push(...remainingResults);
      this.taskQueue = [];
    }

    return results;
  }

  private getIdleAgent(): SubAgent | undefined {
    return this.agents.find(agent => agent.status === 'idle');
  }

  getAgentCount(): number {
    return this.agents.length;
  }

  getBusyAgentCount(): number {
    return this.agents.filter(agent => agent.status === 'busy').length;
  }

  stopAll(): void {
    for (const agent of this.agents) {
      agent.stop();
    }
  }
}