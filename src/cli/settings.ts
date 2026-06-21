import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Settings Schema ──────────────────────────────────────────────

export interface AxiomSettings {
  /** Provider configuration */
  provider?: {
    type?: "deepseek" | "anthropic" | "openai";
    model?: string;
    /** API key reference (NEVER put real keys here — use env vars) */
    apiKeyEnv?: string; // env var name, e.g. "DEEPSEEK_API_KEY"
  };

  /** Display preferences */
  display?: {
    color?: boolean;
    showTokens?: boolean;
    showCost?: boolean;
  };

  /** Permission mode */
  permission?: "default" | "auto" | "bypass";

  /** Context configuration */
  context?: {
    maxTokens?: number;
    compactionThreshold?: number; // 0.0 ~ 1.0
  };

  /** Session configuration */
  session?: {
    autoResume?: boolean;
    persistPath?: string;
  };

  /** Project configuration */
  project?: {
    /** File to load as agent instructions (e.g. AGENTS.md, CLAUDE.md) */
    instructionsFile?: string;
    /** Auto-load git status on startup */
    loadGitStatus?: boolean;
  };

  /** Tools configuration */
  tools?: {
    /** Built-in tools to enable */
    builtin?: string[];
    /** Disable specific tools */
    disabled?: string[];
  };

  /** Limits */
  limits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    maxToolCallsPerTurn?: number;
  };

  /** Hook commands (executed before/after agent runs) */
  hooks?: {
    /** Command to run before each agent call */
    preRun?: string;
    /** Command to run after each agent call */
    postRun?: string;
  };
}

// ─── Default Settings ─────────────────────────────────────────────

export function defaultSettings(): AxiomSettings {
  return {
    provider: {
      type: "deepseek",
      model: "deepseek-v4-flash",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    display: {
      color: true,
      showTokens: true,
      showCost: true,
    },
    permission: "default",
    context: {
      maxTokens: 128000,
      compactionThreshold: 0.85,
    },
    session: {
      autoResume: true,
    },
    project: {
      instructionsFile: "AGENTS.md",
      loadGitStatus: true,
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
      disabled: [],
    },
    limits: {
      maxTurns: 200,
      maxBudgetUsd: 50,
      maxToolCallsPerTurn: 20,
    },
  };
}

// ─── Settings Paths ───────────────────────────────────────────────

export function getSettingsPaths(cwd: string): { global: string; project: string } {
  const home = process.env["AXIOM_HOME"] || join(homedir(), ".axiom");
  return {
    global: join(home, "settings.json"),
    project: join(cwd, ".axiom", "settings.json"),
  };
}

// ─── Settings Loader ──────────────────────────────────────────────

export class SettingsLoader {
  private globalPath: string;
  private projectPath: string;

  constructor(cwd: string) {
    const paths = getSettingsPaths(cwd);
    this.globalPath = paths.global;
    this.projectPath = paths.project;
  }

  /**
   * Load and merge settings from all sources.
   * Priority: defaults < global < project < env vars
   */
  load(): AxiomSettings {
    let settings = defaultSettings();

    // Layer 1: global settings (~/.axiom/settings.json)
    settings = this.merge(settings, this.loadFile(this.globalPath));

    // Layer 2: project settings (./.axiom/settings.json)
    settings = this.merge(settings, this.loadFile(this.projectPath));

    // Layer 3: environment variables (highest priority)
    settings = this.applyEnvOverrides(settings);

    return settings;
  }

  /** Save settings to the global path */
  saveGlobal(settings: AxiomSettings): void {
    const dir = dirname(this.globalPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.globalPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  /** Save settings to the project path */
  saveProject(settings: AxiomSettings): void {
    const dir = dirname(this.projectPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.projectPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  /** Initialize a default settings file if none exists */
  init(scope: "global" | "project"): string {
    const targetPath = scope === "global" ? this.globalPath : this.projectPath;
    if (!existsSync(targetPath)) {
      const defaults = defaultSettings();
      const dir = dirname(targetPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(targetPath, JSON.stringify(defaults, null, 2), "utf-8");
      return targetPath;
    }
    return targetPath;
  }

  /** Print the effective settings */
  print(): void {
    const settings = this.load();
    console.log(JSON.stringify(settings, null, 2));
  }

  // ─── Private ─────────────────────────────────────────────────

  private loadFile(filePath: string): AxiomSettings {
    try {
      if (!existsSync(filePath)) return {};
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content) as AxiomSettings;
    } catch {
      return {};
    }
  }

  /** Deep merge: override replaces primitive values, merges objects */
  private merge(base: AxiomSettings, override: AxiomSettings): AxiomSettings {
    const result = { ...base };

    for (const [key, value] of Object.entries(override)) {
      if (value === undefined || value === null) continue;

      const baseVal = (result as Record<string, unknown>)[key];
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof baseVal === "object" &&
        !Array.isArray(baseVal) &&
        baseVal !== null
      ) {
        (result as Record<string, unknown>)[key] = {
          ...(baseVal as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }

    return result;
  }

  private applyEnvOverrides(settings: AxiomSettings): AxiomSettings {
    // Provider
    if (process.env["AXIOM_PROVIDER"]) {
      if (!settings.provider) settings.provider = {};
      settings.provider.type = process.env["AXIOM_PROVIDER"] as "deepseek" | "anthropic" | "openai";
    }
    if (process.env["AXIOM_MODEL"]) {
      if (!settings.provider) settings.provider = {};
      settings.provider.model = process.env["AXIOM_MODEL"];
    }

    // Display
    if (process.env["AXIOM_NO_COLOR"]) {
      if (!settings.display) settings.display = {};
      settings.display.color = false;
    }

    // Permission
    if (process.env["AXIOM_PERMISSION"]) {
      settings.permission = process.env["AXIOM_PERMISSION"] as AxiomSettings["permission"];
    }

    // Limits
    if (process.env["AXIOM_MAX_TURNS"]) {
      if (!settings.limits) settings.limits = {};
      settings.limits.maxTurns = parseInt(process.env["AXIOM_MAX_TURNS"]) || settings.limits.maxTurns;
    }
    if (process.env["AXIOM_MAX_BUDGET"]) {
      if (!settings.limits) settings.limits = {};
      settings.limits.maxBudgetUsd = parseFloat(process.env["AXIOM_MAX_BUDGET"]) || settings.limits.maxBudgetUsd;
    }

    return settings;
  }
}
