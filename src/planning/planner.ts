import type { Task, Plan, PlanResult, TaskResult } from './types.js';
import type { TaskExecutor } from './task-executor.js';

/** Planner that creates and executes plans. */
export class Planner {
  private currentPlan: Plan | null = null;

  async createPlan(tasks: Task[], description: string = 'User-requested plan'): Promise<Plan> {
    // Optimize task order based on dependencies
    const optimizedTasks = this.optimizeOrder(tasks);
    
    // Calculate estimated total time
    const estimatedTotalTime = optimizedTasks.reduce((sum, task) => sum + task.estimatedTime, 0);
    
    // Identify all required tools
    const requiredTools = [...new Set(optimizedTasks.flatMap(task => task.requiredTools))];
    
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      description,
      tasks: optimizedTasks,
      estimatedTotalTime,
      requiredTools,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.currentPlan = plan;
    return plan;
  }

  async executePlan(plan: Plan, executor: TaskExecutor): Promise<PlanResult> {
    const startTime = Date.now();
    const results: TaskResult[] = [];
    
    plan.status = 'in_progress';
    plan.updatedAt = Date.now();

    try {
      for (const task of plan.tasks) {
        // Check if all dependencies are completed
        const dependenciesCompleted = task.dependencies.every(depId => {
          const depResult = results.find(r => r.taskId === depId);
          return depResult && depResult.success;
        });

        if (!dependenciesCompleted) {
          results.push({
            taskId: task.id,
            success: false,
            error: 'Dependencies not completed',
            executionTime: 0,
          });
          continue;
        }

        // Execute task
        const taskStartTime = Date.now();
        try {
          const result = await executor.execute(task);
          const executionTime = Date.now() - taskStartTime;
          
          results.push({
            taskId: task.id,
            success: true,
            result: result.result,
            executionTime,
          });

          // Update task status
          task.status = 'completed';
          task.result = result.result;
        } catch (error) {
          const executionTime = Date.now() - taskStartTime;
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          results.push({
            taskId: task.id,
            success: false,
            error: errorMessage,
            executionTime,
          });

          // Update task status
          task.status = 'failed';
          task.error = errorMessage;
        }
      }

      const totalTime = Date.now() - startTime;
      const success = results.every(r => r.success);
      
      plan.status = success ? 'completed' : 'failed';
      plan.updatedAt = Date.now();

      return {
        planId: plan.id,
        success,
        results,
        totalTime,
        summary: this.generateSummary(plan, results, totalTime),
      };
    } catch (error) {
      const totalTime = Date.now() - startTime;
      plan.status = 'failed';
      plan.updatedAt = Date.now();
      
      return {
        planId: plan.id,
        success: false,
        results,
        totalTime,
        summary: `Plan execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private optimizeOrder(tasks: Task[]): Task[] {
    // Topological sort based on dependencies
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (task: Task) => {
      if (visited.has(task.id)) return;
      if (visiting.has(task.id)) {
        // Circular dependency detected, skip
        return;
      }

      visiting.add(task.id);

      // Visit dependencies first
      for (const depId of task.dependencies) {
        const depTask = tasks.find(t => t.id === depId);
        if (depTask) {
          visit(depTask);
        }
      }

      visiting.delete(task.id);
      visited.add(task.id);
      sorted.push(task);
    };

    for (const task of tasks) {
      visit(task);
    }

    return sorted;
  }

  private generateSummary(plan: Plan, results: TaskResult[], totalTime: number): string {
    const completed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const totalTasks = plan.tasks.length;

    let summary = `Plan "${plan.description}" completed.\n`;
    summary += `Tasks: ${completed}/${totalTasks} completed, ${failed} failed.\n`;
    summary += `Total time: ${(totalTime / 1000).toFixed(1)}s.\n`;

    if (failed > 0) {
      summary += `Failed tasks:\n`;
      results
        .filter(r => !r.success)
        .forEach(r => {
          summary += `  - ${r.taskId}: ${r.error}\n`;
        });
    }

    return summary;
  }

  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }
}