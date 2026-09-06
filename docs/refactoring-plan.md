# Nova 重构方案：匹配主流编码代理架构

## 目标
将 Nova 重构为匹配主流开源编码代理（SWE-agent、AutoCodeRover、Aider）的架构，实现：
1. 全面的工具使用模式
2. 记忆/缓存系统（高缓存命中率）
3. 规划能力
4. 网络搜索功能（开源解决方案）
5. 子代理功能
6. 高性能和可扩展性

## 架构差距分析

### 当前 Nova 架构
- 工具注册表和执行管道（基础）
- 上下文管理（简单截断）
- 无缓存系统
- 无规划能力
- 基础网络搜索（Tavily + DuckDuckGo）
- 无子代理功能

### 主流编码代理架构特点

#### SWE-agent
- 工具接口驱动，LLM 自主使用工具
- 配置驱动（YAML 文件）
- 支持多种 LLM
- 自动化软件工程任务

#### AutoCodeRover
- 两阶段方法：上下文检索 + 补丁生成
- 程序结构感知的代码搜索（基于 AST）
- 利用测试套件进行统计故障定位
- 支持多种 LLM 提供商

#### Aider
- 映射整个代码库
- Git 集成（自动提交）
- 支持多种编程语言
- 支持图像和网页
- 语音到代码
- 自动 lint 和测试

## 重构方案

### 1. 工具使用模式增强

**改进点：**
- 增强工具接口，支持更丰富的元数据
- 实现工具执行管道，支持并行执行
- 添加工具结果缓存
- 实现工具权限的细粒度控制

**具体实现：**
```typescript
// 增强的工具接口
interface EnhancedTool extends Tool {
  metadata: {
    category: string;
    requiresContext: boolean;
    cacheable: boolean;
    timeout: number;
  };
  executeWithCache(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// 工具执行管道
class ToolExecutionPipeline {
  private cache: ToolResultCache;
  private permissionChecker: PermissionChecker;
  
  async execute(tool: EnhancedTool, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // 1. 检查缓存
    if (tool.metadata.cacheable) {
      const cached = await this.cache.get(tool.name, params);
      if (cached) return cached;
    }
    
    // 2. 检查权限
    const permission = await this.permissionChecker.check(tool.name, params);
    if (permission.decision === 'deny') {
      return { content: 'Permission denied', isError: true };
    }
    
    // 3. 执行工具
    const result = await tool.execute(params, context);
    
    // 4. 缓存结果
    if (tool.metadata.cacheable) {
      await this.cache.set(tool.name, params, result);
    }
    
    return result;
  }
}
```

### 2. 记忆/缓存系统

**三层缓存架构：**
1. **LLM 响应缓存**：缓存 LLM API 响应，减少 API 调用
2. **工具结果缓存**：缓存工具执行结果，避免重复执行
3. **上下文缓存**：缓存项目分析结果，提高上下文理解效率

**实现：**
```typescript
// 缓存接口
interface Cache<K, V> {
  get(key: K): Promise<V | null>;
  set(key: K, value: V, ttl?: number): Promise<void>;
  delete(key: K): Promise<void>;
  clear(): Promise<void>;
  getStats(): CacheStats;
}

// LLM 响应缓存
class LLMResponseCache implements Cache<string, StreamChunk[]> {
  private store: Map<string, { chunks: StreamChunk[]; timestamp: number }>;
  private ttl: number; // 默认 1 小时
  
  async get(key: string): Promise<StreamChunk[] | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.chunks;
  }
  
  async set(key: string, chunks: StreamChunk[]): Promise<void> {
    this.store.set(key, { chunks, timestamp: Date.now() });
  }
}

// 工具结果缓存
class ToolResultCache implements Cache<string, ToolResult> {
  private store: Map<string, { result: ToolResult; timestamp: number }>;
  private ttl: number; // 默认 5 分钟
  
  async get(key: string): Promise<ToolResult | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.result;
  }
  
  async set(key: string, result: ToolResult): Promise<void> {
    this.store.set(key, { result, timestamp: Date.now() });
  }
}

// 上下文缓存
class ContextCache implements Cache<string, ProjectContext> {
  private store: Map<string, { context: ProjectContext; timestamp: number }>;
  private ttl: number; // 默认 10 分钟
  
  async get(key: string): Promise<ProjectContext | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.context;
  }
  
  async set(key: string, context: ProjectContext): Promise<void> {
    this.store.set(key, { context, timestamp: Date.now() });
  }
}
```

### 3. 规划能力

**任务分解和规划循环：**
- 分析用户请求，分解为子任务
- 创建执行计划
- 按计划执行任务
- 监控进度，调整计划

**实现：**
```typescript
// 任务分解器
class TaskDecomposer {
  async decompose(userRequest: string, context: ProjectContext): Promise<Task[]> {
    // 使用 LLM 分析请求，分解为子任务
    const prompt = `分析以下请求并分解为子任务：${userRequest}`;
    const response = await this.llm.chat([{ role: 'user', content: prompt }]);
    return this.parseTasks(response);
  }
}

// 规划器
class Planner {
  private tasks: Task[] = [];
  private currentTaskIndex: number = 0;
  
  async createPlan(tasks: Task[]): Promise<Plan> {
    // 优化任务顺序，考虑依赖关系
    const optimized = this.optimizeOrder(tasks);
    return {
      tasks: optimized,
      estimatedTime: this.estimateTime(optimized),
      requiredTools: this.identifyTools(optimized),
    };
  }
  
  async executePlan(plan: Plan, executor: TaskExecutor): Promise<PlanResult> {
    const results: TaskResult[] = [];
    
    for (const task of plan.tasks) {
      const result = await executor.execute(task);
      results.push(result);
      
      if (result.status === 'failed') {
        // 重新规划
        const newPlan = await this.replan(plan, results);
        return this.executePlan(newPlan, executor);
      }
    }
    
    return { results, success: true };
  }
}

// 任务执行器
class TaskExecutor {
  async execute(task: Task): Promise<TaskResult> {
    // 根据任务类型选择执行策略
    switch (task.type) {
      case 'code_generation':
        return this.executeCodeGeneration(task);
      case 'code_analysis':
        return this.executeCodeAnalysis(task);
      case 'testing':
        return this.executeTesting(task);
      case 'refactoring':
        return this.executeRefactoring(task);
      default:
        return { status: 'failed', error: 'Unknown task type' };
    }
  }
}
```

### 4. 网络搜索功能增强

**开源解决方案集成：**
- 使用 Tavily API（主要）
- DuckDuckGo HTML 抓取（备用）
- 添加搜索结果缓存
- 实现搜索结果排名

**实现：**
```typescript
// 增强的搜索工具
class EnhancedWebSearchTool implements Tool {
  name = 'web_search';
  description = 'Search the web for information';
  
  private cache: Cache<string, SearchResult[]>;
  private providers: SearchProvider[];
  
  constructor() {
    this.cache = new LLMResponseCache();
    this.providers = [
      new TavilyProvider(),
      new DuckDuckGoProvider(),
    ];
  }
  
  async execute(params: { query: string; num_results?: number }): Promise<ToolResult> {
    const { query, num_results = 5 } = params;
    
    // 检查缓存
    const cacheKey = `search:${query}:${num_results}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { content: JSON.stringify(cached) };
    }
    
    // 执行搜索
    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, num_results);
        await this.cache.set(cacheKey, results);
        return { content: JSON.stringify(results) };
      } catch (error) {
        continue;
      }
    }
    
    return { content: 'Search failed', isError: true };
  }
}
```

### 5. 子代理功能

**并行代理执行：**
- 创建子代理池
- 分配任务给子代理
- 并行执行任务
- 合并结果

**实现：**
```typescript
// 子代理接口
interface SubAgent {
  id: string;
  status: 'idle' | 'busy' | 'error';
  execute(task: Task): Promise<TaskResult>;
}

// 子代理池
class SubAgentPool {
  private agents: SubAgent[] = [];
  private taskQueue: Task[] = [];
  
  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.agents.push(new DefaultSubAgent(`agent-${i}`));
    }
  }
  
  async executeTasks(tasks: Task[]): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const promises: Promise<TaskResult>[] = [];
    
    for (const task of tasks) {
      const agent = this.getIdleAgent();
      if (agent) {
        agent.status = 'busy';
        promises.push(
          agent.execute(task).then(result => {
            agent.status = 'idle';
            return result;
          })
        );
      } else {
        this.taskQueue.push(task);
      }
    }
    
    // 等待所有任务完成
    const taskResults = await Promise.all(promises);
    results.push(...taskResults);
    
    // 处理队列中的任务
    if (this.taskQueue.length > 0) {
      const remainingResults = await this.executeTasks(this.taskQueue);
      results.push(...remainingResults);
    }
    
    return results;
  }
  
  private getIdleAgent(): SubAgent | undefined {
    return this.agents.find(agent => agent.status === 'idle');
  }
}

// 默认子代理实现
class DefaultSubAgent implements SubAgent {
  id: string;
  status: 'idle' | 'busy' | 'error' = 'idle';
  
  constructor(id: string) {
    this.id = id;
  }
  
  async execute(task: Task): Promise<TaskResult> {
    // 使用独立的代理循环执行任务
    const agentLoop = new AgentLoop({
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      config: { maxToolRounds: 10, model: this.model },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    
    await agentLoop.processUserInput(task.description);
    return { status: 'completed', result: 'Task completed' };
  }
}
```

### 6. 缓存命中率优化

**缓存策略：**
- L1 缓存（内存）：快速访问，小容量
- L2 缓存（磁盘）：大容量，持久化
- 智能失效策略：基于 TTL 和访问模式
- 缓存预热：启动时加载常用数据

**监控和优化：**
```typescript
// 缓存监控
class CacheMonitor {
  private stats: Map<string, CacheStats> = new Map();
  
  recordHit(cacheName: string): void {
    const stats = this.stats.get(cacheName) || { hits: 0, misses: 0, size: 0 };
    stats.hits++;
    this.stats.set(cacheName, stats);
  }
  
  recordMiss(cacheName: string): void {
    const stats = this.stats.get(cacheName) || { hits: 0, misses: 0, size: 0 };
    stats.misses++;
    this.stats.set(cacheName, stats);
  }
  
  getHitRate(cacheName: string): number {
    const stats = this.stats.get(cacheName);
    if (!stats) return 0;
    return stats.hits / (stats.hits + stats.misses);
  }
  
  getReport(): string {
    let report = 'Cache Performance Report:\n';
    for (const [name, stats] of this.stats) {
      const hitRate = this.getHitRate(name);
      report += `${name}: ${hitRate.toFixed(2)}% hit rate (${stats.hits} hits, ${stats.misses} misses)\n`;
    }
    return report;
  }
}
```

## 实施计划

### 阶段 1：基础架构增强（1-2 周）
1. 增强工具接口和注册表
2. 实现基础缓存系统
3. 添加缓存监控

### 阶段 2：核心功能实现（2-3 周）
1. 实现 LLM 响应缓存
2. 实现工具结果缓存
3. 增强网络搜索功能

### 阶段 3：高级功能（2-3 周）
1. 实现规划能力
2. 实现子代理功能
3. 优化缓存命中率

### 阶段 4：集成和测试（1-2 周）
1. 集成所有组件
2. 编写测试用例
3. 性能测试和优化

## 验证标准

1. **功能验证**：
   - 所有现有测试通过
   - 新功能测试通过
   - 缓存命中率 > 70%

2. **性能验证**：
   - 响应时间减少 30%
   - API 调用减少 50%
   - 内存使用合理

3. **架构验证**：
   - 代码结构清晰
   - 模块解耦
   - 可扩展性强

## 风险和缓解

1. **风险**：缓存一致性问题
   - **缓解**：实现缓存失效策略，定期清理

2. **风险**：子代理资源竞争
   - **缓解**：实现资源池管理，限制并发数

3. **风险**：规划算法复杂度
   - **缓解**：使用简单启发式算法，逐步优化

## 结论

通过本次重构，Nova 将具备主流编码代理的核心功能，包括工具使用、缓存系统、规划能力、网络搜索和子代理功能。这将显著提升 Nova 的性能和用户体验，使其在编码代理领域具有竞争力。