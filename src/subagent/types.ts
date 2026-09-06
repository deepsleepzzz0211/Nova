/** Subagent status. */
export type SubAgentStatus = 'idle' | 'busy' | 'error' | 'stopped';

/** Subagent configuration. */
export interface SubAgentConfig {
  id: string;
  maxConcurrentTasks: number;
  timeout: number;
}

/** Subagent task. */
export interface SubAgentTask {
  id: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  requiredTools: string[];
}

/** Subagent result. */
export interface SubAgentResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
  executionTime: number;
}

/** Subagent interface. */
export interface SubAgent {
  id: string;
  status: SubAgentStatus;
  execute(task: SubAgentTask): Promise<SubAgentResult>;
  stop(): void;
}