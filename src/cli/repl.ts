import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Message, ToolUseBlock, ToolResultBlock } from "../types/index.js";
import type { TokenUsage } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { ToolRegistry, resolveTools } from "../tools/index.js";
import { SystemPromptBuilder } from "../context/system-prompt.js";
import { FileMemoryStore } from "../memory/file-store.js";
import { SessionManager, type Session } from "../session/manager.js";
import {
  type CLIConfig,
  defaultCLIConfig,
  cliConfigFromSettings,
  toAgentConfig,
  loadInstructionsFile,
} from "./config.js";
import { SettingsLoader, getSettingsPaths, type AxiomSettings } from "./settings.js";
import { builtinCommands, type CommandContext } from "./commands.js";
import { StreamView } from "./stream-view.js";
import { PermissionPrompt } from "./permission-prompt.js";
import { loadProjectContext, buildContextString } from "./context-loader.js";

// ─── REPL State ───────────────────────────────────────────────────

interface REPLState {
  cwd: string;
  config: CLIConfig;
  sessionId: string;
  messages: Message[];
  totalTokens: TokenUsage;
  totalCost: number;
  toolCallCount: number;
  compactCount: number;
}

// ─── CLI REPL ─────────────────────────────────────────────────────

export async function startREPL(cwd: string, cliConfig?: Partial<CLIConfig>): Promise<void> {
  // ─── Load Settings ──────────────────────────────────────────
  const settingsLoader = new SettingsLoader(cwd);
  // Init defaults on first run
  settingsLoader.init("global");

  const settings = settingsLoader.load();
  const config = cliConfigFromSettings(cwd, settings);

  // Override with any passed-in CLI config
  if (cliConfig) Object.assign(config, cliConfig);

  const projectCtx = loadProjectContext(cwd, config.project.instructionsFile);
  const instructions = loadInstructionsFile(cwd, config.project.instructionsFile) ??
    loadInstructionsFile(cwd, "CLAUDE.md");
  const agentConfig = toAgentConfig(config, instructions);

  // UI helpers
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "▸ ",
    terminal: true,
  });
  const view = new StreamView({ color: config.display.color, showTokens: config.display.showTokens });
  const permissions = new PermissionPrompt(config.permission, rl);

  // Provider + Registry
  const provider = createProvider({
    type: config.provider.type,
    apiKey: config.provider.apiKey,
    defaultModel: config.provider.model,
  });
  const registry = new ToolRegistry();
  const tools = resolveTools(agentConfig.tools.builtin);
  registry.registerAll(tools);

  // Session
  const sessionMgr = new SessionManager(agentConfig);
  const sid = randomUUID();
  sessionMgr.create(agentConfig);

  // Memory
  const memoryStore = new FileMemoryStore(agentConfig.memory.storagePath);
  await memoryStore.init();

  // System prompt
  const sysBuilder = new SystemPromptBuilder(agentConfig);
  sysBuilder.setVariables({
    cwd,
    date: projectCtx.date,
    platform: projectCtx.platform,
    sessionId: sid,
  });
  const dynamicCtx = buildContextString(projectCtx);
  sysBuilder.setVariable("dynamicContext", dynamicCtx);

  const state: REPLState = {
    cwd,
    config,
    sessionId: sid,
    messages: [],
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    totalCost: 0,
    toolCallCount: 0,
    compactCount: 0,
  };

  // ─── Banner ──────────────────────────────────────────────────
  const settingsPaths = getSettingsPaths(cwd);
  console.log(`\n⚡ ${bold("Axiom CLI Agent", config.display.color)}`);
  console.log(`${dim("Provider:", config.display.color)} ${config.provider.type} / ${config.provider.model}`);
  console.log(`${dim("Project:", config.display.color)}  ${cwd}`);
  if (projectCtx.gitBranch) {
    console.log(`${dim("Branch:", config.display.color)}  ${projectCtx.gitBranch}`);
  }
  if (instructions) {
    console.log(`${dim("Config:", config.display.color)}  ${config.project.instructionsFile} loaded (${instructions.length} chars)`);
  }
  console.log(`${dim("Settings:", config.display.color)} ${settingsPaths.global}`);
  console.log(`${dim("Commands:", config.display.color)} /help for slash commands\n`);

  // ─── Main Loop ───────────────────────────────────────────────
  const promptUser = () => {
    rl.setPrompt("▸ ");
    rl.prompt();
  };

  promptUser();

  rl.on("line", async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      promptUser();
      return;
    }

    // Slash commands
    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed, state, rl);
      promptUser();
      return;
    }

    // Ctrl+D or exit
    if (trimmed === "exit" || trimmed === "quit") {
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
    }

    // ─── Run Agent ───────────────────────────────────────────
    view.reset();
    let stopReason = "completed";

    try {
      const sysPrompt = sysBuilder.build() + "\n" + dynamicCtx;

      const result = await runAgentLoop(
        {
          config: agentConfig,
          provider,
          registry,
          context: {
            cwd,
            sessionId: state.sessionId,
            readOnly: false,
            signal: undefined,
            readFile: async (p, off, lim) => {
              const fs = await import("node:fs/promises");
              const content = await fs.readFile(p, "utf-8");
              const lines = content.split("\n");
              return lines.slice(off ?? 0, lim ? (off ?? 0) + lim : undefined).join("\n");
            },
            writeFile: async (p, c) => {
              const fs = await import("node:fs/promises");
              const path = await import("node:path");
              await fs.mkdir(path.dirname(p), { recursive: true });
              await fs.writeFile(p, c, "utf-8");
            },
          },
          onEvent: async (event: AgentEvent) => {
            // Check permissions before executing tools
            if (event.type === "tool_use") {
              // Permission check is handled inside agent-loop; skip here
            }
            // Forward to stream view
            view.handle(event);
          },
        },
        trimmed,
      );

      // Update state
      state.messages = result.messages;
      state.totalTokens.inputTokens += result.usage.inputTokens;
      state.totalTokens.outputTokens += result.usage.outputTokens;
      state.toolCallCount += view.totalToolCalls;
      stopReason = result.stopReason;

      // Cost calculation
      const costPerM = config.provider.type === "deepseek"
        ? { input: 0.27, output: 1.10 } // DeepSeek V3 pricing
        : { input: 3, output: 15 }; // Claude pricing
      const costUsd =
        (result.usage.inputTokens / 1_000_000) * costPerM.input +
        (result.usage.outputTokens / 1_000_000) * costPerM.output;
      state.totalCost += costUsd;

      // Print summary
      if (config.display.showCost) {
        console.log(
          dim(
            `  ${result.usage.inputTokens.toLocaleString()}+${result.usage.outputTokens.toLocaleString()} tokens · $${costUsd.toFixed(4)} · ${stopReason}`,
            config.display.color,
          ),
        );
      }
    } catch (err) {
      console.error(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist session
    try {
      sessionMgr.updateSession(state.messages, stopReason as import("../types/index.js").StopReason, state.totalTokens);
      await sessionMgr.persist();
    } catch { /* persist optional */ }

    promptUser();
  });

  rl.on("close", () => {
    console.log("\nSession ended.");
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\nInterrupted. Type /clear to start fresh or Ctrl+D to exit.");
    view.reset();
    promptUser();
  });
}

// ─── Command Handler ──────────────────────────────────────────────

async function handleCommand(
  input: string,
  state: REPLState,
  rl: readline.Interface,
): Promise<void> {
  const parts = input.slice(1).split(/\s+/);
  const cmdName = parts[0] ?? "";
  const args = parts.slice(1);

  const cmds = builtinCommands();
  const cmd = cmds.find((c) => c.name === cmdName || c.aliases.includes(cmdName));

  if (!cmd) {
    console.log(`Unknown command: /${cmdName}\nType /help for available commands.`);
    return;
  }

  const ctx: CommandContext = {
    cwd: state.cwd,
    config: state.config,
    sessionId: state.sessionId,
    messageCount: state.messages.length,
    totalTokens: {
      input: state.totalTokens.inputTokens,
      output: state.totalTokens.outputTokens,
    },
    totalCost: state.totalCost,
  };

  try {
    const output = await cmd.execute(args, ctx);
    console.log(output);
  } catch (err) {
    console.error(`Command error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── ANSI Helpers ─────────────────────────────────────────────────

function bold(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

function dim(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `\x1b[2m${text}\x1b[0m`;
}
