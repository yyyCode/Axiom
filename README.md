# Axiom — 通用 AI Agent 内核

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)

从零实现的 TypeScript AI Agent 运行时，仿 Claude Code 架构。可作为**小说生成**、**视频制作**、**CLI 助手**等场景的 Agent 大脑。

## 架构

```
while (model returns tool_use) {
  execute tools (read-only parallel, mutating serial)
  feed results back to model
}
```

## 快速开始

```bash
npm install @axiom/agent-kernel
```

```typescript
import { createProvider, defineTool, runAgentLoop, ToolRegistry, resolveTools } from "@axiom/agent-kernel";
import { z } from "zod";

const provider = createProvider({ type: "deepseek" });

const myTool = defineTool(
  { name: "hello", description: "打个招呼" },
  { name: z.string() },
  async (input) => ({ content: `你好, ${input.name}!` }),
);

const registry = new ToolRegistry();
registry.registerAll(resolveTools(["read_file", "write_file"], [myTool]));

const result = await runAgentLoop(
  { config, provider, registry, context: { cwd: ".", sessionId: "s1", readOnly: false, ... } },
  "帮我写一段代码",
);
```

## 模块

| 模块 | 功能 |
|------|------|
| `core/agent-loop` | 核心 while 循环 |
| `core/tool-executor` | 并发/串行工具执行 |
| `core/permission` | 单关卡权限系统 |
| `core/subagent` | 子 Agent 隔离调度 |
| `providers/` | Anthropic / OpenAI / DeepSeek 适配 |
| `tools/builtin/` | 10+ 内置工具 |
| `context/` | System Prompt + 3 层上下文压缩 |
| `memory/` | Markdown 文件记忆 + SQLite 结构化存储 |
| `session/` | 会话生命周期管理 |

## Provider 切换

```typescript
createProvider({ type: "deepseek" })   // → DEEPSEEK_API_KEY
createProvider({ type: "openai" })     // → OPENAI_API_KEY
createProvider({ type: "anthropic" })  // → ANTHROPIC_API_KEY
```

## 分支

| 分支 | 说明 |
|------|------|
| `main` | **内核 SDK**（当前分支）— 核心运行时 |
| `cli` | CLI Agent — 终端 REPL + 斜杠命令 |
| `full-stack` | 完整项目 — 内核 + Web 服务 + 前端 |

## License

MIT
