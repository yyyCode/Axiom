/**
 * Novel Generation Agent — 小说生成Agent示例
 *
 * 演示如何使用 Axiom Agent Kernel 构建一个小说创作Agent。
 * 包含自定义工具：角色管理、章节生成、剧情追踪、世界观设定。
 */

import { z } from "zod";
import {
  createProvider,
  defineTool,
  runAgentLoop,
  ToolRegistry,
  SystemPromptBuilder,
  SessionManager,
  FileMemoryStore,
  SqliteMemoryStore,
  type AgentConfig,
} from "../src/index.js";

// ─── Custom Novel-Writing Tools ───────────────────────────────────

/** 生成小说章节 */
const generateChapterTool = defineTool(
  {
    name: "generate_chapter",
    description:
      "Generate a chapter of the novel. Provide the chapter number, title, and any plot requirements. Returns the full chapter text.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    chapter_number: z.number().min(1).describe("Chapter number"),
    title: z.string().describe("Chapter title"),
    plot_beats: z.string().describe("Key plot points for this chapter"),
    word_count: z.number().optional().describe("Target word count (default: 3000)"),
    pov_character: z.string().optional().describe("Point-of-view character"),
  },
  async (input, ctx) => {
    // In a real implementation, this would:
    // 1. Load relevant character info from memory
    // 2. Load plot arc data
    // 3. Generate chapter content via LLM with proper prompts
    // 4. Save the chapter to the file system
    // 5. Update character states and plot progress

    ctx.log(`Generating chapter ${input.chapter_number}: "${input.title}"`);

    // The actual generation happens via the main LLM calling back
    // This tool prepares the context and returns the result
    return {
      content: `[Chapter ${input.chapter_number} scaffold ready]\nTitle: ${input.title}\nPOV: ${input.pov_character ?? "Narrator"}\nTarget: ${input.word_count ?? 3000} words\nPlot beats: ${input.plot_beats}\n\nChapter generation context prepared.`,
      data: {
        chapter: input.chapter_number,
        title: input.title,
        status: "scaffold_ready",
      },
    };
  },
);

/** 管理角色信息 */
const manageCharacterTool = defineTool(
  {
    name: "manage_character",
    description:
      "Create or update a character in the novel. Maintains character consistency across chapters.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    action: z.enum(["create", "update", "query", "list"]).describe("Action to perform"),
    name: z.string().optional().describe("Character name"),
    attributes: z.record(z.unknown()).optional().describe(
      "Character attributes (traits, backstory, relationships, etc.)",
    ),
    character_id: z.string().optional().describe("Character ID for update/query"),
  },
  async (input, ctx) => {
    const store = new SqliteMemoryStore();

    switch (input.action) {
      case "create": {
        await store.saveEntity({
          id: "",
          type: "character",
          name: input.name ?? "Unknown",
          attributes: (input.attributes as Record<string, unknown>) ?? {},
          relationships: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return {
          content: `Character created: ${input.name}`,
          data: { name: input.name },
        };
      }

      case "query": {
        const results = await store.findEntities("character", { name: input.name });
        if (results.length === 0) {
          return { content: `No character found matching: ${input.name ?? "(all)"}` };
        }
        return {
          content: results.map((c) =>
            `[${c.id}] ${c.name}: ${JSON.stringify(c.attributes, null, 2)}`
          ).join("\n\n"),
          data: { characters: results },
        };
      }

      case "list": {
        const all = await store.findEntities("character");
        return {
          content: all.length === 0
            ? "No characters defined yet."
            : all.map((c) => `- ${c.name} [${c.id}]`).join("\n"),
          data: { characters: all },
        };
      }

      default:
        return { content: `Unknown action: ${input.action}`, isError: true };
    }
  },
);

/** 管理世界观设定 */
const manageWorldBuildingTool = defineTool(
  {
    name: "manage_worldbuilding",
    description:
      "Create or query world-building elements: settings, rules, history, factions, magic systems, etc.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    action: z.enum(["create", "query", "list"]),
    category: z.enum(["setting", "rule", "history", "faction", "magic_system", "technology"]).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
  },
  async (input) => {
    // Similar to manageCharacterTool, stores world-building entities
    return {
      content: `World-building [${input.category ?? "general"}] "${input.name ?? ""}": ${input.description ?? "(query)"}`,
      data: { category: input.category, name: input.name },
    };
  },
);

/** 追踪剧情线 */
const managePlotTool = defineTool(
  {
    name: "manage_plot",
    description:
      "Track and query plot arcs. Each arc has a name, summary, status, and list of related chapters.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    action: z.enum(["create_arc", "update_arc", "query", "list_arcs"]),
    arc_name: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(["planned", "in_progress", "resolved", "abandoned"]).optional(),
    related_chapters: z.array(z.number()).optional(),
  },
  async (input) => {
    return {
      content: `Plot arc "${input.arc_name ?? "(all)"}": ${input.status ?? "query"}`,
      data: { arcName: input.arc_name, status: input.status },
    };
  },
);

// ─── Agent Configuration ─────────────────────────────────────────

const novelAgentConfig: AgentConfig = {
  identity: {
    name: "NovelForge",
    description: "An AI agent specialized in novel writing. Helps plan, write, and edit novels with character and plot consistency.",
    instructions: `You are a novel-writing agent. Your purpose is to help the user create compelling fiction.

Core responsibilities:
1. Plan novels: structure plots, develop characters, design world-building
2. Write chapters: generate prose following the established style and canon
3. Maintain consistency: track character voices, plot continuity, and world rules
4. Edit and revise: review chapters for pacing, dialogue quality, and coherence

Writing guidelines:
- Maintain consistent character voices and motivations
- Track foreshadowing and payoffs across chapters
- Balance showing vs. telling
- Vary sentence structure for rhythm
- Use dialogue to reveal character`,
  },

  provider: {
    type: "anthropic",
    model: "claude-sonnet-4-6",
    params: {
      temperature: 0.8, // Higher creativity for fiction
      maxTokens: 8192,
    },
  },

  tools: {
    builtin: [
      "read_file",
      "write_file",
      "glob",
      "grep",
      "task_management",
    ],
    custom: [
      generateChapterTool,
      manageCharacterTool,
      manageWorldBuildingTool,
      managePlotTool,
    ],
    allowDynamicTools: false,
  },

  context: {
    maxTokens: 200000,
    compactionThreshold: 0.85,
    injectInstructions: true,
    enableCaching: true,
    systemPromptAppend: `Novel structure:
  Chapters are stored in novel/chapters/ch_NN_title.md
  Characters are stored in novel/characters/name.md
  World building in novel/worldbuilding/category/name.md
  Plot arcs in novel/plots/arcs.md

Before writing each chapter:
1. Review relevant character sheets
2. Check active plot arcs
3. Review the previous chapter
4. Plan the chapter structure
5. Write with consistent voice and pacing`,
  },

  memory: {
    storagePath: "./novel-project/.axiom/memory",
    enableStructured: true,
    maxAutoLoad: 10,
    consolidateAfterSessions: 5,
  },

  session: {
    maxTurns: 100,
    maxBudgetUsd: 50,
    persistPath: "./novel-project/.axiom/sessions",
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

  subagents: {
    enabled: true,
    maxDepth: 2,
    tools: [
      generateChapterTool,
      manageCharacterTool,
    ],
  },
};

// ─── Main Entry ───────────────────────────────────────────────────

async function main() {
  // Initialize
  const provider = createProvider({
    type: novelAgentConfig.provider.type,
    apiKey: process.env["ANTHROPIC_API_KEY"],
  });

  const registry = new ToolRegistry();
  const { resolveTools } = await import("../src/tools/index.js");
  const tools = resolveTools(
    novelAgentConfig.tools.builtin,
    novelAgentConfig.tools.custom,
  );
  registry.registerAll(tools);

  const sessions = new SessionManager(novelAgentConfig);
  const memoryStore = new FileMemoryStore(novelAgentConfig.memory.storagePath);
  await memoryStore.init();

  const sysBuilder = new SystemPromptBuilder(novelAgentConfig);
  sysBuilder.setVariables({
    cwd: process.cwd(),
    date: new Date().toISOString().split("T")[0],
    platform: `${process.platform} ${process.arch}`,
    sessionId: "novel-session-001",
  });

  // Run the agent
  console.log("📖 NovelForge Agent starting...\n");

  const result = await runAgentLoop(
    {
      config: novelAgentConfig,
      provider,
      registry,
      context: {
        cwd: process.cwd(),
        sessionId: "novel-session-001",
        readOnly: false,
        readFile: async (p, o, l) => {
          const fs = await import("node:fs/promises");
          const content = await fs.readFile(p, "utf-8");
          const lines = content.split("\n");
          const start = o ?? 0;
          const end = l ? start + l : lines.length;
          return lines.slice(start, end).join("\n");
        },
        writeFile: async (p, c) => {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, c, "utf-8");
        },
      },
      onEvent: (event) => {
        switch (event.type) {
          case "text_delta":
            process.stdout.write(event.text);
            break;
          case "tool_use":
            console.log(`\n🔧 Tool: ${event.name}`);
            break;
          case "turn_start":
            console.log(`\n─ Turn ${event.turn} ─`);
            break;
          case "done":
            console.log(`\n✅ Done: ${event.reason}`);
            break;
          case "error":
            console.error(`\n❌ Error: ${event.message}`);
            break;
        }
      },
    },
    "写一个修仙小说的第一章，主角叫林尘，从一个凡人小镇开始，意外觉醒了远古血脉。字数约3000字。",
  );

  console.log(`\n📊 Usage: ${result.usage.inputTokens} in + ${result.usage.outputTokens} out tokens`);
  console.log(`🛑 Stop reason: ${result.stopReason}`);
}

main().catch(console.error);
