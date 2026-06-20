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

## 快速开始（CLI 模式）

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

支持 `/help` `/clear` `/compact` `/memory` `/cost` `/model` `/tools` `/session` 等斜杠命令。

### SDK 模式

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
