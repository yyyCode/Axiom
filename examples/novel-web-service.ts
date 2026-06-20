/**
 * Novel Generation Web Service — 完整示例
 *
 * 演示：Kernel + Harness → 小说生成 Web 服务
 *
 * 启动后：
 *   POST http://localhost:3000/api/agent/run  → 发起写作任务
 *   GET  http://localhost:3000/api/agent/stream?runId=xxx  → SSE实时接收
 *
 * 前端可以这样消费：
 *   const es = new EventSource(`/api/agent/stream?runId=${runId}`);
 *   es.addEventListener('text', e => appendText(e.data.text));
 *   es.addEventListener('tool', e => showToolCall(e.data));
 *   es.addEventListener('done', e => console.log('Finished', e.data));
 */

import { z } from "zod";
import {
  createProvider,
  defineTool,
  FileMemoryStore,
  SqliteMemoryStore,
  type AgentConfig,
  type ToolDefinition,
} from "../src/index.js";
import { AgentServer, type AgentProfile } from "../src/harness/index.js";

// ─── 1. 自定义小说工具 ────────────────────────────────────────────

function createNovelTools(tenantId: string): ToolDefinition[] {
  const memoryPath = `./data/${tenantId}/memory`;

  return [
    defineTool(
      {
        name: "generate_chapter",
        description:
          "生成小说章节。需要章节号、标题、剧情要点和字数目标。返回完整章节文本。",
        isMutating: true,
        riskLevel: "safe",
      },
      {
        chapter_number: z.number().min(1),
        title: z.string(),
        plot_beats: z.string().describe("本章关键剧情"),
        word_count: z.number().default(3000),
        pov_character: z.string().optional().describe("视角角色"),
      },
      async (input, ctx) => {
        ctx.log(`写第${input.chapter_number}章: "${input.title}"`);
        return {
          content: `[章节 ${input.chapter_number} 框架]\n标题: ${input.title}\n视角: ${input.pov_character ?? "旁白"}\n字数: ${input.word_count}\n剧情: ${input.plot_beats}\n\n章节生成上下文已就绪，继续生成正文...`,
        };
      },
    ),

    defineTool(
      {
        name: "manage_character",
        description: "创建或查询角色。维护角色一致性。",
        isMutating: true,
        riskLevel: "safe",
      },
      {
        action: z.enum(["create", "update", "query", "list"]),
        name: z.string().optional(),
        attributes: z.record(z.unknown()).optional(),
      },
      async (input, ctx) => {
        const store = new SqliteMemoryStore();
        if (input.action === "list") {
          const chars = await store.findEntities("character");
          return {
            content: chars.length === 0
              ? "暂无角色。"
              : chars.map((c) => `- ${c.name} [${c.id}]`).join("\n"),
          };
        }
        return { content: `角色操作完成: ${input.action} ${input.name ?? ""}` };
      },
    ),

    defineTool(
      {
        name: "manage_plot",
        description: "追踪剧情线。支持创建、更新、查询剧情弧。",
        isMutating: true,
        riskLevel: "safe",
      },
      {
        action: z.enum(["create_arc", "update_arc", "query", "list_arcs"]),
        arc_name: z.string().optional(),
        summary: z.string().optional(),
        status: z.enum(["planned", "in_progress", "resolved"]).optional(),
      },
      async (input) => ({
        content: `剧情弧 "${input.arc_name ?? "(全部)"}": 状态=${input.status ?? "查询"}`,
      }),
    ),

    defineTool(
      {
        name: "manage_worldbuilding",
        description: "管理世界观设定：场景、规则、历史、势力等。",
        isMutating: true,
        riskLevel: "safe",
      },
      {
        action: z.enum(["create", "query", "list"]),
        category: z
          .enum(["setting", "rule", "history", "faction", "magic_system"])
          .optional(),
        name: z.string().optional(),
        description: z.string().optional(),
      },
      async (input) => ({
        content: `世界观 [${input.category ?? "通用"}]: "${input.name ?? ""}"`,
      }),
    ),
  ];
}

// ─── 2. 注册 Agent Profile ────────────────────────────────────────

function createNovelAgentProfile(): AgentProfile {
  return {
    type: "novel",
    displayName: "NovelForge",
    description: "AI小说写作助手 — 从大纲到正文，保持角色和剧情一致性",

    configFactory: (tenantId: string): AgentConfig => ({
      identity: {
        name: "NovelForge",
        description: "专业小说写作AI，擅长修仙、玄幻、都市等类型",
        instructions: `你是一个小说创作Agent。

写作原则：
- 每章保持一致的叙事风格和视角
- 角色对话要符合其性格设定
- 平衡"展示vs讲述"的比例
- 善用伏笔和呼应的技巧
- 动作场景保持快节奏，文戏注重细节

流程：
1. 先查阅相关角色设定（manage_character）
2. 检查进行中的剧情线（manage_plot）
3. 查阅世界观设定（manage_worldbuilding）
4. 规划章节结构
5. 生成章节正文`,
      },
      provider: {
        type: "anthropic",
        model: "claude-sonnet-4-6",
        params: { temperature: 0.8, maxTokens: 8192 },
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
        systemPromptAppend: `项目目录: ./data/${tenantId}/novel-project/
  章节: chapters/ch_NN.md
  角色: characters/name.md
  世界观: worldbuilding/category/name.md
  剧情: plots/arcs.md`,
      },
      memory: {
        storagePath: `./data/${tenantId}/memory`,
        enableStructured: true,
        maxAutoLoad: 10,
        consolidateAfterSessions: 5,
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

    toolsFactory: async (tenantId: string) => createNovelTools(tenantId),
  };
}

// ─── 3. 启动 Web 服务 ─────────────────────────────────────────────

async function main() {
  const server = new AgentServer({
    port: 3000,
    host: "0.0.0.0",
    devMode: true, // 生产环境用 auth 回调代替
    dataDir: "./data",
    allowOrigins: ["*"],
  });

  // 注册 Agent
  server.registerAgent(createNovelAgentProfile());

  // 还可以注册更多：
  // server.registerAgent(createVideoAgentProfile());
  // server.registerAgent(createCodeAgentProfile());

  await server.start();

  console.log(`
📖 NovelForge Web Service Ready
────────────────────────────────
启动写作任务:
  curl -X POST http://localhost:3000/api/agent/run \\
    -H "Content-Type: application/json" \\
    -d '{"agentType":"novel","prompt":"写修仙小说第一章：凡人小镇的少年意外觉醒远古血脉","sessionId":"my-novel-1"}'

实时接收 (SSE):
  const es = new EventSource('/api/agent/stream?runId=<返回的runId>');
  es.addEventListener('text', e => process.stdout.write(JSON.parse(e.data).data.text));
  es.addEventListener('done', e => console.log('完成', JSON.parse(e.data).data));

查看任务:
  curl http://localhost:3000/api/agent/tasks

健康检查:
  curl http://localhost:3000/api/health
  `);

  // 优雅退出
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
