import {
  type AgentConfig,
  type SubAgentSpec,
  type SubAgentResult,
  type ToolDefinition,
} from "../types/index.js";
import { type BaseProvider } from "../providers/base.js";
import { type ToolRegistry } from "../tools/registry.js";
import { runAgentLoop, type AgentLoopOptions } from "./agent-loop.js";

// ─── Sub-Agent Manager ────────────────────────────────────────────

/**
 * Sub-agent manager — spawns and manages sub-agents.
 *
 * Architecture (inspired by Claude Code):
 *  - Each sub-agent runs with isolated context (fresh messages array)
 *  - Sub-agents have a constrained tool set
 *  - Sub-agent depth is limited to prevent recursive proliferation
 *  - Results are summarized back to the parent agent
 *  - Multiple sub-agents can run in parallel
 */
export class SubAgentManager {
  private config: AgentConfig;
  private provider: BaseProvider;
  private registry: ToolRegistry;
  private activeSubAgents: Map<string, AbortController> = new Map();
  private depth = 0;

  constructor(
    config: AgentConfig,
    provider: BaseProvider,
    registry: ToolRegistry,
    depth = 0,
  ) {
    this.config = config;
    this.provider = provider;
    this.registry = registry;
    this.depth = depth;
  }

  /** Spawn a sub-agent */
  async spawn(spec: SubAgentSpec): Promise<SubAgentResult> {
    // Depth check
    if (this.depth >= this.config.subagents.maxDepth) {
      return {
        id: spec.id,
        output: `Error: maximum sub-agent depth (${this.config.subagents.maxDepth}) exceeded.`,
        toolCalls: 0,
        turns: 0,
        tokensUsed: 0,
      };
    }

    // Count check
    if (this.activeSubAgents.size >= this.config.limits.maxSubAgents) {
      return {
        id: spec.id,
        output: `Error: maximum concurrent sub-agents (${this.config.limits.maxSubAgents}) reached.`,
        toolCalls: 0,
        turns: 0,
        tokensUsed: 0,
      };
    }

    const controller = new AbortController();
    this.activeSubAgents.set(spec.id, controller);

    // Build sub-agent tools
    const subTools: ToolDefinition[] = spec.tools ??
      (this.config.subagents.tools.length > 0
        ? this.config.subagents.tools
        : this.registry.getAll().filter((t) => !t.isMutating || t.riskLevel === "safe"));

    // Create a sub-registry
    const subRegistry = new (this.registry.constructor as new () => ToolRegistry)();
    for (const tool of subTools) {
      subRegistry.register(tool);
    }

    // Sub-agent config (inherit from parent, override model)
    const subConfig: AgentConfig = {
      ...this.config,
      provider: {
        ...this.config.provider,
        model: spec.model ?? this.config.subagents.model ?? this.config.provider.model,
      },
      limits: {
        ...this.config.limits,
        maxTurns: spec.maxTurns ?? Math.min(10, this.config.limits.maxTurns),
      },
    };

    const loopOpts: AgentLoopOptions = {
      config: subConfig,
      provider: this.provider,
      registry: subRegistry,
      context: {
        cwd: process.cwd(),
        sessionId: `${this.config.session.persistPath}/sub_${spec.id}`,
        readOnly: false,
        signal: controller.signal,
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
          await fs.mkdir(require("node:path").dirname(p), { recursive: true });
          await fs.writeFile(p, c, "utf-8");
        },
      },
    };

    try {
      const result = await runAgentLoop(loopOpts, spec.prompt);

      // Extract final text from the last assistant message
      let output = "";
      for (let i = result.messages.length - 1; i >= 0; i--) {
        const msg = result.messages[i];
        if (msg?.role === "assistant") {
          const textBlocks = msg.content.filter((b) => b.type === "text");
          output = textBlocks.map((b) => (b as { text: string }).text).join("\n");
          break;
        }
      }

      return {
        id: spec.id,
        output: output || "(no text output)",
        toolCalls: result.messages.filter(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((b: { type: string }) => b.type === "tool_result"),
        ).length,
        turns: result.messages.filter((m) => m.role === "assistant").length,
        tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
      };
    } catch (err) {
      return {
        id: spec.id,
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: 0,
        turns: 0,
        tokensUsed: 0,
      };
    } finally {
      this.activeSubAgents.delete(spec.id);
    }
  }

  /** Spawn multiple sub-agents in parallel */
  async spawnParallel(specs: SubAgentSpec[]): Promise<SubAgentResult[]> {
    return Promise.all(specs.map((s) => this.spawn(s)));
  }

  /** Cancel a running sub-agent */
  cancel(id: string): void {
    const controller = this.activeSubAgents.get(id);
    controller?.abort();
  }

  /** Cancel all running sub-agents */
  cancelAll(): void {
    for (const [, controller] of this.activeSubAgents) {
      controller.abort();
    }
    this.activeSubAgents.clear();
  }

  /** Number of active sub-agents */
  get activeCount(): number {
    return this.activeSubAgents.size;
  }
}
