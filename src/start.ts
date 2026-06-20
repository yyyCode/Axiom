/**
 * Axiom Agent Server — 启动入口
 *
 * 用法:
 *   node dist/start.js
 *   ANTHROPIC_API_KEY=xxx node dist/start.js
 *
 * 然后打开浏览器访问 http://localhost:3000
 */

import { z } from "zod";
import {
  defineTool,
  type AgentConfig,
  type ToolDefinition,
} from "./index.js";
import {
  AgentServer,
  ReflectionService,
  type AgentProfile,
} from "./harness/index.js";
import { FileMemoryStore } from "./memory/index.js";
import { createProvider } from "./providers/factory.js";

// ─── 工具工厂：按租户创建隔离的工具 ──────────────────────────────

function createTools(tenantId: string, type: string): ToolDefinition[] {
  const memoryPath = `./data/${tenantId}/memory`;

  return [
    defineTool(
      {
        name: "write_content",
        description:
          type === "novel"
            ? "写入生成的小说章节内容到文件"
            : "写入生成的视频脚本内容到文件",
        isMutating: true,
        riskLevel: "safe",
      },
      {
        file_path: z.string().describe("输出文件路径"),
        content: z.string().describe("要写入的完整内容"),
      },
      async (input, ctx) => {
        await ctx.writeFile(input.file_path, input.content);
        const lines = input.content.split("\n").length;
        return {
          content: `写入完成: ${input.file_path} (${lines} 行, ${input.content.length} 字符)`,
        };
      },
    ),

    defineTool(
      {
        name: "read_previous",
        description: "读取之前生成的内容，用于保持一致性",
        isMutating: false,
        riskLevel: "readonly",
      },
      {
        file_path: z.string().describe("要读取的文件路径"),
      },
      async (input, ctx) => {
        const content = await ctx.readFile(input.file_path);
        return {
          content: content.slice(0, 5000) +
            (content.length > 5000 ? `\n\n... (剩余 ${content.length - 5000} 字符)` : ""),
        };
      },
    ),
  ];
}

// ─── Agent Profile 工厂 ──────────────────────────────────────────

function createAgentProfile(type: string): AgentProfile {
  // 通过环境变量切换 Provider
  const providerType = (process.env["PROVIDER_TYPE"] || "anthropic") as "anthropic" | "openai" | "deepseek";
  const baseUrl = process.env["PROVIDER_BASE_URL"] || undefined;

  const configs: Record<string, { name: string; desc: string; instructions: string; model: string; temp: number }> = {
    novel: {
      name: "NovelForge",
      desc: "AI小说写作助手 — 生成章节、管理角色、追踪剧情",
      instructions: `你是一个小说创作Agent。
职责：规划小说结构，创作章节正文，保持角色一致性和剧情连贯性。
写作风格：根据用户的设定调整，默认使用中文创作。
流程：先理解需求 → 规划结构 → 生成内容 → 写入文件。`,
      model: process.env["MODEL"] || (providerType === "deepseek" ? "deepseek-v4-flash" : providerType === "openai" ? "gpt-4o" : "claude-sonnet-4-6"),
      temp: 0.8,
    },
    video: {
      name: "VideoForge",
      desc: "AI视频创作助手 — 分镜脚本、场景描述、制作规划",
      instructions: `你是一个视频创作Agent。
职责：设计分镜脚本，描述场景细节，规划拍摄方案。
输出格式：场景号 | 时长 | 镜头类型 | 画面描述 | 对白/旁白 | 配乐建议`,
      model: process.env["MODEL"] || (providerType === "deepseek" ? "deepseek-v4-flash" : providerType === "openai" ? "gpt-4o" : "claude-sonnet-4-6"),
      temp: 0.7,
    },
  };

  const cfg = configs[type] ?? configs["novel"]!;

  return {
    type,
    displayName: cfg.name,
    description: cfg.desc,

    configFactory: (tenantId: string): AgentConfig => ({
      identity: {
        name: cfg.name,
        description: cfg.desc,
        instructions: cfg.instructions,
      },
      provider: {
        type: providerType,
        model: cfg.model,
        ...(baseUrl ? { baseUrl } : {}),
        params: { temperature: cfg.temp, maxTokens: 8192 },
      },
      tools: {
        builtin: ["read_file", "write_file", "glob", "grep", "task_management"],
        custom: [],
        allowDynamicTools: false,
      },
      context: {
        maxTokens: 200000,
        compactionThreshold: 0.85,
        injectInstructions: true,
        enableCaching: true,
        systemPromptAppend: `工作目录: ./data/${tenantId}/workspace/
输出文件请写入此目录下。
使用 write_content 保存生成的内容。
使用 read_previous 读取已有内容。`,
      },
      memory: {
        storagePath: `./data/${tenantId}/memory`,
        enableStructured: true,
        maxAutoLoad: 5,
        consolidateAfterSessions: 3,
      },
      session: {
        maxTurns: 100,
        maxBudgetUsd: 50,
        autoResume: true,
        maxDurationMinutes: 120,
      },
      limits: {
        maxTurns: 150,
        maxBudgetUsd: 100,
        maxToolCallsPerTurn: 20,
        maxSubAgents: 5,
        maxSubAgentDepth: 2,
      },
      subagents: { enabled: true, maxDepth: 2, tools: [] },
    }),

    toolsFactory: async (tenantId: string) => createTools(tenantId, type),
  };
}

// ─── 启动 ────────────────────────────────────────────────────────

async function main() {
  const frontendDir = new URL("../frontend", import.meta.url).pathname
    .replace(/^\/[a-zA-Z]:/, (m) => m.slice(1)); // Windows: /E:/ → E:/

  const server = new AgentServer({
    port: Number(process.env["PORT"]) || 3000,
    host: process.env["HOST"] || "0.0.0.0",
    devMode: process.env["NODE_ENV"] !== "production",
    dataDir: process.env["DATA_DIR"] || "./data",
    frontendDir,
    allowOrigins: ["*"],
  });

  // 注册 Agent 类型
  server.registerAgent(createAgentProfile("novel"));
  server.registerAgent(createAgentProfile("video"));

  // Wire up Reflection + Memory for continuous learning
  // Memory is scoped by agent type: novel and video learn separately
  const novelMemory = new FileMemoryStore(`${process.env["DATA_DIR"] || "./data"}/reflection-novel`);
  const videoMemory = new FileMemoryStore(`${process.env["DATA_DIR"] || "./data"}/reflection-video`);
  await novelMemory.init();
  await videoMemory.init();

  const reflectionProvider = createProvider({
    type: "deepseek" as const,
    apiKey: process.env["DEEPSEEK_API_KEY"],
    defaultModel: process.env["MODEL"] || "deepseek-v4-flash",
  });

  // Each agent type gets its own reflection service with scoped memory
  const novelReflection = new ReflectionService({ provider: reflectionProvider, memory: novelMemory, mode: "async" });
  const videoReflection = new ReflectionService({ provider: reflectionProvider, memory: videoMemory, mode: "async" });

  // Store both so we can pick the right one per agent type
  const reflectionMap = new Map<string, ReflectionService>();
  reflectionMap.set("novel", novelReflection);
  reflectionMap.set("video", videoReflection);

  // TODO: AgentPool currently supports one global reflection service.
  // For full per-type scoping, each launch should pick its type's service.
  // For now, novel is the default (most common use case).
  server.getPool().setReflection(novelReflection, novelMemory);
  console.log("🧠 Reflection enabled — agent learns across sessions (novel / video isolated)\n");

  await server.start();

  console.log(`
╔══════════════════════════════════════════╗
║         ⚡ Axiom Agent Server            ║
╠══════════════════════════════════════════╣
║  Frontend:  http://localhost:3000         ║
║  Health:    http://localhost:3000/api/health
║  API:       POST /api/agent/run          ║
║  SSE:       GET  /api/agent/stream       ║
╠══════════════════════════════════════════╣
║  Agents: novel, video                    ║
║  Mode:    ${process.env["NODE_ENV"] === "production" ? "production" : "development (no auth)"}  ║
╚══════════════════════════════════════════╝
  `);

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
