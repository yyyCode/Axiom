# Axiom — 通用 AI Agent 内核

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

从零实现的 TypeScript AI Agent 运行时，仿 Claude Code 架构。可配置为**小说生成**、**视频制作**、**编程助手**等多种场景的 Agent 大脑。

## 架构

```
        ┌──────────────────────────────────┐
        │          Axiom Agent              │
        │                                  │
        │  while (model has tool_calls) {   │
        │    execute tools → feed back      │
        │  }                               │
        │                                  │
        │  Providers    Tools     Context   │
        │  ┌──────────┐ ┌──────┐ ┌───────┐ │
        │  │DeepSeek  │ │ 10+  │ │ 3-Layer│ │
        │  │Anthropic │ │Built-│ │Compact │ │
        │  │OpenAI    │ │in    │ │        │ │
        │  └──────────┘ └──────┘ └───────┘ │
        │  Memory       Session   SubAgent  │
        │  ┌──────────┐ ┌──────┐ ┌───────┐ │
        │  │Markdown  │ │Resume│ │Isolate│ │
        │  │+ SQLite  │ │Fork  │ │d Ctx  │ │
        │  └──────────┘ └──────┘ └───────┘ │
        └──────────────────────────────────┘
```

## 快速开始

### CLI 模式（推荐日常使用）

```bash
git clone https://github.com/yyyCode/Axiom.git
cd Axiom
npm install && npx tsc && npm link

# 设置 API Key
# Windows: set DEEPSEEK_API_KEY=sk-xxx
# Mac/Linux: export DEEPSEEK_API_KEY=sk-xxx

# 任意目录启动
axiom
```

启动后输入自然语言即可。支持 `/help` `/clear` `/compact` `/memory` `/cost` 等斜杠命令。

### Web 服务模式

```bash
PROVIDER_TYPE=deepseek DEEPSEEK_API_KEY=sk-xxx npm start
# 浏览器打开 http://localhost:3000
```

### SDK 模式（在代码中使用内核）

```typescript
import { createProvider, defineTool, runAgentLoop, ToolRegistry, resolveTools } from "@axiom/agent-kernel";
import { z } from "zod";

const provider = createProvider({ type: "deepseek" });

const myTool = defineTool(
  { name: "write_chapter", description: "写一个章节" },
  { title: z.string(), wordCount: z.number().default(3000) },
  async (input, ctx) => ({ content: `章节"${input.title}"准备就绪` }),
);

const registry = new ToolRegistry();
registry.registerAll(resolveTools(["read_file", "write_file"], [myTool]));

const result = await runAgentLoop(
  { config, provider, registry, context: { ... } },
  "写修仙小说第一章",
);
```

## Provider 支持

| Provider | 模型示例 | 环境变量 |
|----------|---------|---------|
| DeepSeek | `deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-4o` | `OPENAI_API_KEY` |

通过环境变量切换：

```bash
PROVIDER_TYPE=anthropic ANTHROPIC_API_KEY=sk-ant-xxx axiom
PROVIDER_TYPE=openai    OPENAI_API_KEY=sk-xxx    axiom
```

## 项目结构

```
Axiom/
├── src/
│   ├── types/              # 核心类型定义
│   ├── core/               # Agent Loop + 工具执行 + 权限 + 子Agent
│   ├── providers/          # LLM Provider 适配层
│   ├── tools/builtin/      # 10+ 内置工具
│   ├── context/            # System Prompt + 3层上下文压缩
│   ├── memory/             # Markdown + 结构化记忆
│   ├── session/            # 会话生命周期
│   ├── cli/                # CLI Agent (REPL + 斜杠命令)
│   └── harness/            # Web服务层 (HTTP/SSE/多租户)
├── frontend/index.html     # Web 管理台
├── examples/               # 示例代码
└── dist/                   # 编译输出
```

## 分支

| 分支 | 内容 |
|------|------|
| `main` | 完整项目 (kernel + harness + frontend + examples) |
| `kernel-only` | 纯内核 SDK |
| `cli-agent` | CLI Agent (REPL + 斜杠命令 + DeepSeek 适配) |

## 核心特性

- **Agent Loop** — 单线程 while 循环，模型自主决定何时调用工具、何时结束
- **多 Provider** — 一行环境变量切换 Anthropic/OpenAI/DeepSeek
- **可插拔工具** — Zod 校验 + 权限关卡 + 并发/串行执行策略
- **3 层上下文压缩** — MicroCompact → AutoCompact → FullCompact
- **自愈机制** — 工具错误自动诊断 + 重试
- **经验学习** — 任务完成后自动反思，提取规律存入记忆，后续任务自动注入
- **实时流式** — SSE 推送 + ANSI 终端渲染
- **多租户隔离** — 独立 workspace + 并发控制 + 会话持久化

## License

MIT
