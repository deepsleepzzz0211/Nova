import type { Task, TaskType, TaskPriority } from './types.js';
import type { LLMProvider } from '../llm/provider.js';

/** Task decomposer that breaks down user requests into subtasks. */
export class TaskDecomposer {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  async decompose(userRequest: string, context?: Record<string, unknown>): Promise<Task[]> {
    const prompt = this.buildDecompositionPrompt(userRequest, context);
    
    const messages = [
      { role: 'user' as const, content: prompt }
    ];

    let response = '';
    const stream = this.llm.chat(messages, {
      model: 'gpt-4o',
      temperature: 0.3,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        response += chunk.content;
      }
    }

    return this.parseTasks(response);
  }

  private buildDecompositionPrompt(userRequest: string, context?: Record<string, unknown>): string {
    const contextStr = context ? JSON.stringify(context, null, 2) : 'No additional context provided.';
    
    return `You are a task decomposition expert. Analyze the following user request and break it down into specific, actionable subtasks.

User Request: ${userRequest}

Context: ${contextStr}

Please decompose this request into a list of tasks. For each task, provide:
1. Type (code_generation, code_analysis, testing, refactoring, debugging, documentation, research)
2. Description (specific action to take)
3. Priority (low, medium, high, critical)
4. Dependencies (list of task IDs that must complete before this task)
5. Estimated time in milliseconds
6. Required tools (list of tool names needed)

Format your response as a JSON array of tasks. Example:
[
  {
    "id": "task-1",
    "type": "code_analysis",
    "description": "Analyze the existing code structure",
    "priority": "high",
    "dependencies": [],
    "estimatedTime": 5000,
    "requiredTools": ["read_file"]
  }
]

Return ONLY the JSON array, no additional text.`;
  }

  private parseTasks(response: string): Task[] {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }

      const tasksData = JSON.parse(jsonMatch[0]) as Array<{
        id: string;
        type: TaskType;
        description: string;
        priority: TaskPriority;
        dependencies: string[];
        estimatedTime: number;
        requiredTools: string[];
      }>;

      return tasksData.map(task => ({
        ...task,
        status: 'pending' as const,
      }));
    } catch (error) {
      console.error('Failed to parse tasks:', error);
      return [];
    }
  }
}