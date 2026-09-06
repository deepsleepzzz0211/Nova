/** Task types for planning. */
export type TaskType = 
  | 'code_generation'
  | 'code_analysis'
  | 'testing'
  | 'refactoring'
  | 'debugging'
  | 'documentation'
  | 'research';

/** Task status. */
export type TaskStatus = 
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Task priority. */
export type TaskPriority = 
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

/** Task interface. */
export interface Task {
  id: string;
  type: TaskType;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];
  estimatedTime: number; // in milliseconds
  requiredTools: string[];
  result?: string;
  error?: string;
}

/** Plan interface. */
export interface Plan {
  id: string;
  description: string;
  tasks: Task[];
  estimatedTotalTime: number;
  requiredTools: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

/** Plan result interface. */
export interface PlanResult {
  planId: string;
  success: boolean;
  results: TaskResult[];
  totalTime: number;
  summary: string;
}

/** Task result interface. */
export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
  executionTime: number;
}