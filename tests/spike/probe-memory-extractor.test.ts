// SPIKE (not part of the suite): drive the real memory extractor against the
// live provider with full chunk logging, to see WHY the subagent no-ops.
// Run: WEIXIN_API_KEY=... pnpm vitest run tests/spike/probe-memory-extractor.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiaiEngine } from '../../src/llm/piai-engine.js';
import { loadModelCatalogWithEngine, resolveModel } from '../../src/llm/catalog.js';
import { PiProvider } from '../../src/llm/index.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { createMemoryExtractor } from '../../src/memory/extraction-agent.js';
import type { ExtractionSnapshot } from '../../src/memory/extraction-scheduler.js';

const KEY_ENV = 'WEIXIN_API_KEY';
const BASE_URL = 'https://chatapi.weixin.qq.com/openai/v1';
const MODEL_ID = 'Deepseek-v4-flash';

describe('probe memory extractor (live)', () => {
  it('logs every subagent round', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-probe-home-'));
    fs.mkdirSync(path.join(home, '.nova'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.nova', 'models.json'),
      JSON.stringify({
        providers: {
          e2e: {
            api: 'openai-completions',
            baseUrl: BASE_URL,
            apiKey: `$${KEY_ENV}`,
            models: [
              { id: MODEL_ID, name: MODEL_ID, reasoning: true, contextWindow: 200_000, maxTokens: 8_000, compat: { supportsDeveloperRole: false, streamUsage: true } },
            ],
          },
        },
      }),
      'utf8',
    );
    process.env.NOVA_HOME = home;

    const engine = new PiaiEngine();
    const { catalog } = loadModelCatalogWithEngine(engine, [path.join(home, '.nova', 'models.json')]);
    const resolution = resolveModel({ provider: 'e2e', model: MODEL_ID }, catalog);
    const real = new PiProvider({
      engine,
      provider: resolution.name,
      model: resolution.model.id,
      baseUrl: resolution.baseUrl,
      apiKey: resolution.apiKey,
    });
    let round = 0;
    const llm: LLMProvider = {
      name: 'probe',
      capabilities: real.capabilities,
      async *chat(msgs: Message[], opts) {
        round += 1;
        const chunks: StreamChunk[] = [];
        for await (const c of real.chat(msgs, opts)) chunks.push(c);
        console.log(`--- ROUND ${round} ---`);
        for (const c of chunks) {
          if (c.type === 'text_delta') process.stdout.write(`TEXT:${c.content}`);
          else if (c.type === 'thinking_delta') process.stdout.write('');
          else if (c.type === 'tool_call_start') console.log(`\nTOOL_START:${c.name}`);
          else if (c.type === 'tool_call_delta') process.stdout.write(`ARGS:${c.arguments}`);
          else if (c.type === 'error') console.log(`\nSTREAM_ERROR:${c.error}`);
        }
        console.log('\n(end round)');
        yield* chunks;
      },
    };

    const trees = {
      user: path.join(home, '.nova', 'memory'),
      project: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-probe-proj-')),
    };
    fs.mkdirSync(trees.project, { recursive: true });
    const extractor = createMemoryExtractor({
      llm,
      model: MODEL_ID,
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy({
        autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [],
      })),
      trees,
    });
    const window: Message[] = [
      { role: 'user', content: '这个项目里我们规定：安装依赖永远用 pnpm，禁止 npm；提交信息必须用 conventional commits。另外本季度依赖冻结窗口的编号是 MEMO-4417。回答"收到"即可，本轮不要调用任何工具。' },
      { role: 'assistant', content: '收到' },
    ];
    const snapshot: ExtractionSnapshot = { messages: window, memoryDirs: [trees.user, trees.project], workingDirectory: trees.project };
    const status = await extractor(snapshot, window);
    console.log('STATUS:', status);
    for (const dir of [trees.user, trees.project]) {
      if (fs.existsSync(dir)) console.log(dir, '->', fs.readdirSync(dir).join(', '));
    }
    expect(status).toBe('success');
  }, 300_000);
});
