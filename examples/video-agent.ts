/**
 * Video Generation Agent — 视频生成Agent示例
 *
 * 演示如何使用 Axiom Agent Kernel 构建一个视频创作Agent。
 * 包含自定义工具：分镜管理、场景生成、视频渲染、音频处理。
 */

import { z } from "zod";
import {
  createProvider,
  defineTool,
  runAgentLoop,
  ToolRegistry,
  SystemPromptBuilder,
  SessionManager,
  type AgentConfig,
} from "../src/index.js";

// ─── Custom Video Production Tools ────────────────────────────────

/** 创建分镜脚本 */
const storyboardTool = defineTool(
  {
    name: "create_storyboard",
    description:
      "Create a storyboard for a video. Define scenes with descriptions, camera angles, duration, dialogue, and transitions.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    title: z.string().describe("Video/project title"),
    scenes: z.array(z.object({
      scene_number: z.number(),
      description: z.string().describe("Visual description of the scene"),
      camera_angle: z.enum(["wide", "medium", "close-up", "POV", "aerial", "tracking", "static"]).optional(),
      duration_seconds: z.number().min(0.5).max(300),
      dialogue: z.string().optional(),
      music_cue: z.string().optional(),
      transition: z.enum(["cut", "fade", "dissolve", "wipe", "none"]).optional(),
      notes: z.string().optional(),
    })).min(1),
    style_notes: z.string().optional().describe("Overall visual style reference"),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "21:9"]).default("16:9"),
  },
  async (input, ctx) => {
    const totalDuration = input.scenes.reduce(
      (sum, s) => sum + s.duration_seconds,
      0,
    );

    ctx.log(`Storyboard created: ${input.title} (${input.scenes.length} scenes, ${totalDuration}s)`);

    const sceneList = input.scenes.map((s) =>
      `Scene ${s.scene_number}: [${s.camera_angle ?? "medium"}] ${s.description.slice(0, 80)}... (${s.duration_seconds}s)`
    ).join("\n");

    return {
      content: `Storyboard: ${input.title}\n${input.scenes.length} scenes, total duration: ${totalDuration}s\nAspect ratio: ${input.aspect_ratio}\n\n${sceneList}`,
      data: {
        title: input.title,
        sceneCount: input.scenes.length,
        totalDuration,
        aspectRatio: input.aspect_ratio,
      },
    };
  },
);

/** 生成视频场景 */
const renderSceneTool = defineTool(
  {
    name: "render_scene",
    description:
      "Render a video scene using a specified engine. Supports text-to-video, image-to-video, and style transfer.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    scene_number: z.number(),
    engine: z.enum(["runway", "kling", "pika", "sora", "animatediff"]).describe("Video generation engine"),
    prompt: z.string().describe("Text prompt for video generation"),
    negative_prompt: z.string().optional(),
    duration_seconds: z.number().min(1).max(60),
    seed: z.number().optional(),
    style_reference_image: z.string().optional().describe("Path to style reference image"),
    motion_strength: z.number().min(0).max(10).optional(),
  },
  async (input, ctx) => {
    ctx.log(`Rendering scene ${input.scene_number} via ${input.engine}...`);

    // In a real implementation, this would:
    // 1. Call the appropriate video generation API
    // 2. Poll for completion
    // 3. Download and save the rendered video
    // 4. Return the file path

    return {
      content: `Scene ${input.scene_number} render job submitted.\nEngine: ${input.engine}\nPrompt: ${input.prompt.slice(0, 200)}\nDuration: ${input.duration_seconds}s\nStatus: queued (mock — implement actual API call)`,
      data: {
        sceneNumber: input.scene_number,
        engine: input.engine,
        status: "queued",
      },
    };
  },
);

/** 管理音频/配音 */
const manageAudioTool = defineTool(
  {
    name: "manage_audio",
    description:
      "Manage audio for the video: generate voiceovers (TTS), add background music, mix audio tracks.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    action: z.enum(["tts", "add_music", "mix", "analyze"]),
    text: z.string().optional().describe("Text for TTS"),
    voice: z.string().optional().describe("Voice ID or description"),
    music_path: z.string().optional().describe("Path to music file"),
    volume: z.number().min(0).max(1).optional(),
    scene_number: z.number().optional().describe("Target scene for audio"),
  },
  async (input, ctx) => {
    ctx.log(`Audio action: ${input.action}`);

    return {
      content: `Audio [${input.action}] processed for scene ${input.scene_number ?? "N/A"}.`,
      data: { action: input.action, scene: input.scene_number },
    };
  },
);

/** 视频编辑/合成 */
const composeVideoTool = defineTool(
  {
    name: "compose_video",
    description:
      "Compose rendered scenes into a final video with transitions, effects, audio, and subtitles.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    scene_files: z.array(z.string()).describe("Paths to rendered scene files"),
    transition: z.enum(["cut", "fade", "dissolve", "wipe"]).default("dissolve"),
    transition_duration: z.number().default(0.5),
    add_subtitles: z.boolean().default(false),
    subtitle_srt_path: z.string().optional(),
    output_format: z.enum(["mp4", "mov", "webm"]).default("mp4"),
    output_path: z.string(),
  },
  async (input, ctx) => {
    ctx.log(`Composing ${input.scene_files.length} scenes into ${input.output_path}...`);

    // In production, this would call ffmpeg or a cloud rendering service

    return {
      content: `Video composited: ${input.output_path}\nScenes: ${input.scene_files.length}\nTransition: ${input.transition} (${input.transition_duration}s)\nFormat: ${input.output_format}\nSubtitles: ${input.add_subtitles ? "enabled" : "disabled"}`,
      data: {
        outputPath: input.output_path,
        sceneCount: input.scene_files.length,
        format: input.output_format,
      },
    };
  },
);

// ─── Agent Configuration ─────────────────────────────────────────

const videoAgentConfig: AgentConfig = {
  identity: {
    name: "VideoForge",
    description: "An AI agent specialized in video production. Helps storyboard, render, and compose videos.",
    instructions: `You are a video production agent. Help users create videos from concept to completion.

Production workflow:
1. Concept → Storyboard: Plan scenes, camera angles, pacing
2. Storyboard → Render: Generate each scene via video engines
3. Render → Audio: Add TTS voiceovers and background music
4. Audio → Compose: Assemble scenes with transitions and effects
5. Compose → Review: Quality check and iterate

Best practices:
- Plan the full storyboard before rendering any scenes
- Render independent scenes in parallel when possible
- Keep scene durations short (3-10s) for better generation quality
- Use consistent style prompts across scenes
- Always review rendered output before final composition`,
  },

  provider: {
    type: "openai", // Video agents often use GPT-4o for script planning
    model: "gpt-4o",
    params: {
      temperature: 0.7,
      maxTokens: 4096,
    },
  },

  tools: {
    builtin: [
      "read_file",
      "write_file",
      "glob",
      "sub_agent",
      "task_management",
    ],
    custom: [
      storyboardTool,
      renderSceneTool,
      manageAudioTool,
      composeVideoTool,
    ],
    allowDynamicTools: false,
  },

  context: {
    maxTokens: 128000,
    compactionThreshold: 0.85,
    injectInstructions: true,
    enableCaching: true,
    systemPromptAppend: `Video project structure:
  storyboards/     — scene-by-scene plans
  renders/         — rendered scene files
  audio/           — voiceovers and music
  output/          — final composited videos

Video engines available:
  - Runway Gen-3: general purpose, good motion
  - Kling: high quality, cinematic
  - Pika: fast iteration, good for short clips
  - Sora: OpenAI, photorealistic (access-limited)
  - AnimateDiff: open source, custom models`,
  },

  memory: {
    storagePath: "./video-project/.axiom/memory",
    enableStructured: true,
    maxAutoLoad: 5,
    consolidateAfterSessions: 5,
  },

  session: {
    maxTurns: 200,
    maxBudgetUsd: 100,
    persistPath: "./video-project/.axiom/sessions",
    autoResume: true,
    maxDurationMinutes: 180,
  },

  limits: {
    maxTurns: 200,
    maxBudgetUsd: 100,
    maxToolCallsPerTurn: 15,
    maxSubAgents: 8,
    maxSubAgentDepth: 2,
  },

  subagents: {
    enabled: true,
    maxDepth: 2,
    tools: [renderSceneTool, manageAudioTool],
  },
};

// ─── Main Entry ───────────────────────────────────────────────────

async function main() {
  const provider = createProvider({
    type: videoAgentConfig.provider.type,
    apiKey: process.env["OPENAI_API_KEY"],
  });

  const registry = new ToolRegistry();
  const { resolveTools } = await import("../src/tools/index.js");
  const tools = resolveTools(
    videoAgentConfig.tools.builtin,
    videoAgentConfig.tools.custom,
  );
  registry.registerAll(tools);

  console.log("🎬 VideoForge Agent starting...\n");

  const result = await runAgentLoop(
    {
      config: videoAgentConfig,
      provider,
      registry,
      context: {
        cwd: process.cwd(),
        sessionId: "video-session-001",
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
            console.log(`\n🎬 Tool: ${event.name} (${event.id})`);
            break;
          case "compaction":
            console.log(`\n📦 Compaction: ${event.fromTokens} → ${event.toTokens} tokens`);
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
    `创建一个30秒的产品宣传片分镜脚本，产品是一款AI智能手表。
    要求：
    - 8-10个场景
    - 突出产品的健康监测和AI助手功能
    - 现代简约风格
    - 每个场景5-10秒
    - 包含特写和广角镜头组合
    - 建议配乐风格`,
  );

  console.log(`\n📊 Usage: ${result.usage.inputTokens} in + ${result.usage.outputTokens} out tokens`);
  console.log(`🛑 Stop reason: ${result.stopReason}`);
}

main().catch(console.error);
