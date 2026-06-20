import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../types/index.js";

// ─── CLI Config ───────────────────────────────────────────────────

export interface CLIConfig {
  /** Provider settings */
  provider: {
    type: "deepseek" | "anthropic" | "openai";
    model: string;
    apiKey: string;
  };
  /** Display settings */
  display: {
    color: boolean;
    showTokens: boolean;
    showCost: boolean;
    compactWidth: number; // terminal width for formatting
  };
  /** Session settings */
  session: {
    persistPath: string;
    autoResume: boolean;
    maxHistoryFiles: number;
  };
  /** Permission mode */
  permission: "default" | "auto" | "bypass";
  /** Project config */
  project: {
    /** File to load as agent instructions (AGENTS.md, CLAUDE.md, etc.) */
    instructionsFile: string;
    /** Auto-load git status */
    loadGitStatus: boolean;
  };
}

/** Default CLI configuration */
export function defaultCLIConfig(): CLIConfig {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || ".";

  return {
    provider: {
      type: "deepseek",
      model: process.env["AXIOM_MODEL"] || "deepseek-v4-flash",
      apiKey: process.env["DEEPSEEK_API_KEY"] || process.env["OPENAI_API_KEY"] || "",
    },
    display: {
      color: true,
      showTokens: true,
      showCost: true,
      compactWidth: process.stdout.columns || 80,
    },
    session: {
      persistPath: join(home, ".axiom", "sessions"),
      autoResume: true,
      maxHistoryFiles: 50,
    },
    permission: "default",
    project: {
      instructionsFile: "AGENTS.md",
      loadGitStatus: true,
    },
  };
}

/** Convert CLI config to AgentConfig for the kernel */
export function toAgentConfig(cliConfig: CLIConfig, instructions?: string): AgentConfig {
  return {
    identity: {
      name: "Axiom",
      description: "CLI AI coding/writing agent — powered by Axiom Kernel",
      instructions: instructions,
    },
    provider: {
      type: cliConfig.provider.type,
      model: cliConfig.provider.model,
    },
    tools: {
      builtin: [
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "bash",
        "web_search",
        "web_fetch",
        "task_management",
      ],
      custom: [],
      allowDynamicTools: false,
    },
    context: {
      maxTokens: cliConfig.provider.type === "deepseek" ? 128000 : 200000,
      compactionThreshold: 0.85,
      injectInstructions: true,
      enableCaching: true,
    },
    memory: {
      storagePath: join(cliConfig.session.persistPath, "..", "memory"),
      enableStructured: false,
      maxAutoLoad: 3,
      consolidateAfterSessions: 3,
    },
    session: {
      maxTurns: 200,
      maxBudgetUsd: 50,
      persistPath: cliConfig.session.persistPath,
      autoResume: cliConfig.session.autoResume,
      maxDurationMinutes: 180,
    },
    limits: {
      maxTurns: 200,
      maxBudgetUsd: 50,
      maxToolCallsPerTurn: 20,
      maxSubAgents: 5,
      maxSubAgentDepth: 2,
    },
    subagents: { enabled: true, maxDepth: 2, tools: [] },
  };
}

/** Load AGENTS.md from project root */
export function loadInstructionsFile(cwd: string, filename: string): string | undefined {
  const filePath = join(cwd, filename);
  if (existsSync(filePath)) {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      // unreadable
    }
  }
  return undefined;
}
