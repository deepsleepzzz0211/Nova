import type { SubAgent, SubAgentTask, SubAgentResult, SubAgentStatus } from './types.js';
import type { AgentLoop } from '../agent/loop.js';

/** Default subagent implementation using AgentLoop. */
export class DefaultSubAgent implements SubAgent {
  id: string;
  status: SubAgentStatus = 'idle';
  private agentLoop: AgentLoop;
  private timeout: number;

  constructor(id: string, agentLoop: AgentLoop, timeout: number = 30000) {
    this.id = id;
    this.agentLoop = agentLoop;
    this.timeout = timeout;
  }

  async execute(task: SubAgentTask): Promise<SubAgentResult> {
    if (this.status === 'busy') {
      return {
        taskId: task.id,
        success: false,
        error: 'SubAgent is busy',
        executionTime: 0,
      };
    }

    this.status = 'busy';
    const startTime = Date.now();

    try {
      // Create a promise with timeout
      const executionPromise = this.executeTask(task);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Task execution timed out')), this.timeout);
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);
      this.status = 'idle';
      return result;
    } catch (error) {
      this.status = 'error';
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        taskId: task.id,
        success: false,
        error: errorMessage,
        executionTime,
      };
    }
  }

  private async executeTask(task: SubAgentTask): Promise<SubAgentResult> {
    const startTime = Date.now();
    
    // Convert task to user message
    const message = this.taskToMessage(task);
    
    // Execute using agent loop
    await this.agentLoop.processUserInput(message);
    
    const executionTime = Date.now() - startTime;
    
    // For now, return a simple result
    // In a real implementation, we would capture the agent's response
    return {
      taskId: task.id,
      success: true,
      result: `SubAgent ${this.id} completed task "${task.description}"`,
      executionTime,
    };
  }

  private taskToMessage(task: SubAgentTask): string {
    let message = `Please execute the following task:\n\n`;
    message += `Description: ${task.description}\n`;
    message += `Priority: ${task.priority}\n`;
    
    if (task.requiredTools.length > 0) {
      message += `Required tools: ${task.requiredTools.join(', ')}\n`;
    }
    
    return message;
  }

  stop(): void {
    this.status = 'stopped';
  }
}