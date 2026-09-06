# 多提供商 LLM 配置示例

Nova 现在支持多种 LLM 提供商，采用 Pi Agent 风格的模块化架构。

## 支持的提供商

### 1. OpenAI
- **模型**: GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **特点**: 支持流式响应、工具调用、视觉功能
- **配置**:

```toml
[llm]
provider = "openai"
api_key = "your-openai-api-key"
base_url = "https://api.openai.com/v1"
model = "gpt-4o"
```

### 2. Anthropic
- **模型**: Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Sonnet, Claude 3 Haiku
- **特点**: 支持流式响应、工具调用、视觉功能
- **配置**:

```toml
[llm]
provider = "anthropic"
api_key = "your-anthropic-api-key"
model = "claude-3-5-sonnet-20241022"
```

### 3. Ollama (本地模型)
- **模型**: Llama 3, CodeLlama, Mistral, Mixtral 等
- **特点**: 本地运行，无需 API 密钥
- **配置**:

```toml
[llm]
provider = "ollama"
base_url = "http://localhost:11434"
model = "llama3"
```

## 使用方式

### 1. 配置文件
创建 `config.toml` 文件：

```toml
[llm]
provider = "anthropic"
api_key = "your-anthropic-api-key"
model = "claude-3-5-sonnet-20241022"
max_tokens = 4096
temperature = 0.7
```

### 2. 环境变量
```bash
# 设置提供商
export NOVA_PROVIDER="anthropic"

# 设置 API 密钥
export NOVA_API_KEY="your-anthropic-api-key"

# 设置模型
export NOVA_MODEL="claude-3-5-sonnet-20241022"

# 设置基础 URL（可选）
export NOVA_BASE_URL="https://api.anthropic.com"
```

### 3. 命令行参数
```bash
# 使用 OpenAI
nova --model gpt-4o --api-key sk-xxx

# 使用 Anthropic
nova --model claude-3-5-sonnet-20241022 --api-key sk-ant-xxx

# 使用 Ollama
nova --model llama3 --base-url http://localhost:11434
```

## 提供商能力对比

| 特性 | OpenAI | Anthropic | Ollama |
|------|--------|-----------|--------|
| 流式响应 | ✅ | ✅ | ✅ |
| 工具调用 | ✅ | ✅ | ✅ |
| 视觉功能 | ✅ | ✅ | ❌ |
| 最大上下文 | 128K | 200K | 32K |
| 本地运行 | ❌ | ❌ | ✅ |

## 自定义提供商

你可以注册自定义提供商：

```typescript
import { providerRegistry } from './llm/registry.js';

class CustomProvider implements LLMProvider {
  name = 'custom';
  capabilities = {
    streaming: true,
    toolCalling: false,
    vision: false,
    maxContextLength: 4096,
    models: ['custom-model'],
  };
  
  async *chat(messages, options) {
    // 实现自定义逻辑
    yield { type: 'text_delta', content: 'Custom response' };
  }
}

// 注册自定义提供商
providerRegistry.register('custom', CustomProvider);
```

## 故障排除

### 常见问题

1. **API 密钥错误**
   - 确保 API 密钥正确且有效
   - 检查环境变量或配置文件中的密钥

2. **模型不可用**
   - 确认模型名称正确
   - 检查提供商是否支持该模型

3. **连接问题**
   - 对于 Ollama，确保本地服务正在运行
   - 检查网络连接和防火墙设置

### 调试模式

启用调试模式查看详细日志：

```bash
DEBUG=nova:* nova
```