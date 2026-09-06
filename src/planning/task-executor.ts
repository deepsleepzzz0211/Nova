import type { Task, TaskResult } from './types.js';
import type { AgentLoop } from '../agent/loop.js';

/** Task executor that runs tasks using the agent loop. */
export class TaskExecutor {
  private agentLoop: AgentLoop;

  constructor(agentLoop: AgentLoop) {
    this.agentLoop = agentLoop;
  }

  async execute(task: Task): Promise<{ result: string }> {
    // Convert task to user message
    const message = this.taskToMessage(task);
    
    // Execute using agent loop
    await this.agentLoop.processUserInput(message);
    
    // For now, return a simple result
    // In a real implementation, we would capture the agent's response
    return {
      result: `Task "${task.description}" executed successfully.`,
    };
  }

  private taskToMessage(task: Task): string {
    let message = `Please execute the following task:\n\n`;
    message += `Type: ${task.type}\n`;
    message += `Description: ${task.description}\n`;
    message += `Priority: ${task.priority}\n`;
    
    if (task.requiredTools.length > 0) {
      message += `Required tools: ${task.requiredTools.join(', ')}\n`;
    }
    
    if (task.dependencies.length > 0) {
      message += `Dependencies: ${task.dependencies.join(', ')}\n`;
    }
    
    return message;
  }
}