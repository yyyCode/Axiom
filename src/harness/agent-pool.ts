import { randomUUID } from "node:crypto";
import {
  type AgentConfig,
  type AgentEvent,
  type StopReason,
} from "../types/index.js";
import { type BaseProvider, type TokenUsage } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import { ToolRegistry, resolveTools } from "../tools/index.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { type AgentProfile, type AgentTask, type AgentRunResult } from "./types.js";
import { type SSEStream } from "./sse.js";

// ─── Agent Instance ────────────────────────────────────────────────

interface AgentInstance {
  task: AgentTask;
  provider: BaseProvider;
  registry: ToolRegistry;
  config: AgentConfig;
  abortController: AbortController;
}

// ─── Agent Pool ────────────────────────────────────────────────────

/**
 * Manages the lifecycle of agent runs.
 *
 * Responsibilities:
 *  - Enforce per-tenant concurrency limits
 *  - Track running/completed tasks
 *  - Provide cancellation capability
 *  - Collect usage statistics
 */
export class AgentPool {
  private profiles = new Map<string, AgentProfile>();
  private tasks = new Map<string, AgentTask>();
  private running = new Map<string, AgentInstance>();
  private tenantConcurrency = new Map<string, number>();
  private maxConcurrencyPerTenant = 5;

  /** Register an agent profile */
  registerProfile(profile: AgentProfile): void {
    this.profiles.set(profile.type, profile);
  }

  /** Get all registered profile types */
  getProfileTypes(): string[] {
    return [...this.profiles.keys()];
  }

  /** Get a profile */
  getProfile(type: string): AgentProfile | undefined {
    return this.profiles.get(type);
  }

  /** Get task status */
  getTask(runId: string): AgentTask | undefined {
    return this.tasks.get(runId);
  }

  /** Register a pending task before SSE connects (eager creation for /api/agent/tasks) */
  registerPending(
    runId: string,
    tenantId: string,
    agentType: string,
    prompt: string,
    sessionId?: string,
  ): void {
    const task: AgentTask = {
      runId,
      tenantId,
      agentType,
      sessionId: sessionId ?? "",
      prompt,
      status: "queued",
      progress: "Waiting for SSE connection...",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(runId, task);
  }

  /** List all tasks for a tenant */
  listTasks(tenantId: string): AgentTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.tenantId === tenantId)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  /** Get tenant's current concurrency */
  getTenantConcurrency(tenantId: string): number {
    return this.tenantConcurrency.get(tenantId) ?? 0;
  }

  /**
   * Launch an agent run.
   *
   * Returns immediately with runId. Agent runs asynchronously.
   * Progress is streamed via the SSE registry.
   */
  async launch(
    tenantId: string,
    agentType: string,
    prompt: string,
    stream: SSEStream,
    overrides?: {
      sessionId?: string;
      model?: string;
      maxTurns?: number;
      maxBudgetUsd?: number;
      readOnly?: boolean;
    },
  ): Promise<string> {
    // Check profile
    const profile = this.profiles.get(agentType);
    if (!profile) {
      stream.send("error", {
        message: `Unknown agent type: ${agentType}. Available: ${this.getProfileTypes().join(", ")}`,
      });
      stream.close();
      return "";
    }

    // Check concurrency
    const current = this.tenantConcurrency.get(tenantId) ?? 0;
    if (current >= this.maxConcurrencyPerTenant) {
      stream.send("error", {
        message: `Concurrency limit (${this.maxConcurrencyPerTenant}) reached for tenant ${tenantId}`,
      });
      stream.close();
      return "";
    }

    const runId = randomUUID();
    const sessionId = overrides?.sessionId ?? randomUUID();
    this.tenantConcurrency.set(tenantId, current + 1);

    // Update existing pending task or create new
    const existing = this.tasks.get(runId);
    const task: AgentTask = {
      runId,
      tenantId,
      agentType,
      sessionId,
      prompt,
      status: "running",
      progress: "Initializing...",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(runId, task);

    // Build config and registry
    const config = profile.configFactory(tenantId);
    if (overrides?.model) config.provider.model = overrides.model;
    if (overrides?.maxTurns) config.limits.maxTurns = overrides.maxTurns;
    if (overrides?.maxBudgetUsd) config.limits.maxBudgetUsd = overrides.maxBudgetUsd;

    const customTools = await profile.toolsFactory(tenantId);
    const tools = resolveTools(config.tools.builtin, customTools);
    const registry = new ToolRegistry();
    registry.registerAll(tools);

    const provider = createProvider({
      type: config.provider.type,
      apiKey: config.provider.apiKey,
      baseUrl: config.provider.baseUrl,
    });

    const abortController = new AbortController();

    const instance: AgentInstance = {
      task,
      provider,
      registry,
      config,
      abortController,
    };
    this.running.set(runId, instance);

    // ─── Run agent in background ──────────────────────────────
    this.executeRun(runId, instance, prompt, sessionId, stream, overrides?.readOnly ?? false)
      .catch((err) => {
        stream.send("error", {
          message: `Fatal: ${err instanceof Error ? err.message : String(err)}`,
        });
        stream.close();
      });

    return runId;
  }

  /** Cancel a running agent */
  cancel(runId: string): boolean {
    const instance = this.running.get(runId);
    if (!instance) return false;

    instance.abortController.abort();
    instance.task.status = "cancelled";
    instance.task.finishedAt = new Date().toISOString();
    this.running.delete(runId);
    this.decrementConcurrency(instance.task.tenantId);
    return true;
  }

  // ─── Private ─────────────────────────────────────────────────

  private async executeRun(
    runId: string,
    instance: AgentInstance,
    prompt: string,
    sessionId: string,
    stream: SSEStream,
    readOnly: boolean,
  ): Promise<void> {
    const { task, provider, registry, config } = instance;

    let toolCallCount = 0;
    let turnCount = 0;

    try {
      task.progress = "Running agent loop...";
      console.log(`\n[${runId.slice(0,8)}] 🚀 Agent started: ${task.agentType}`);
      console.log(`[${runId.slice(0,8)}] Provider: ${config.provider.type}, Model: ${config.provider.model}`);
      console.log(`[${runId.slice(0,8)}] Tools: ${registry.listNames().join(", ")}`);
      console.log(`[${runId.slice(0,8)}] Prompt: ${prompt.slice(0, 100)}...`);

      const result = await runAgentLoop(
        {
          config,
          provider,
          registry,
          context: {
            cwd: process.cwd(),
            sessionId,
            readOnly,
            signal: instance.abortController.signal,
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
          onEvent: (event: AgentEvent) => {
            // Forward to SSE
            stream.forward(event);

            // Backend logging
            switch (event.type) {
              case "turn_start":
                turnCount = event.turn;
                console.log(`[${runId.slice(0,8)}] ── Turn ${event.turn} ──`);
                break;
              case "text_delta":
                process.stdout.write(event.text);
                break;
              case "tool_use":
                toolCallCount++;
                console.log(`\n[${runId.slice(0,8)}] 🔧 tool_use: ${event.name} ${JSON.stringify(event.input).slice(0, 80)}`);
                break;
              case "tool_result":
                console.log(`[${runId.slice(0,8)}]   → result: ${event.result.slice(0, 100)}`);
                break;
              case "tool_error":
                console.log(`[${runId.slice(0,8)}]   ❌ error: ${event.error.slice(0, 100)}`);
                break;
              case "error":
                console.error(`[${runId.slice(0,8)}] ❌ ${event.message}`);
                break;
              case "done":
                console.log(`\n[${runId.slice(0,8)}] ✅ Done: ${event.reason} (${turnCount} turns, ${toolCallCount} tool calls)`);
                break;
              case "compaction":
                console.log(`[${runId.slice(0,8)}] 📦 Compaction: ${event.fromTokens} → ${event.toTokens}`);
                break;
            }
          },
        },
        prompt,
      );

      // Done
      task.status = "completed";
      task.progress = "Done";
      task.result = this.buildResult(result.stopReason, result.usage, toolCallCount);
      task.result = { ...task.result, turns: turnCount };
      task.finishedAt = new Date().toISOString();
      console.log(`[${runId.slice(0,8)}] 📊 Usage: ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, cost=$${task.result.costUsd}`);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isUserInterrupt = instance.abortController.signal.aborted;

      console.error(`[${runId.slice(0,8)}] ❌ Agent error:`, err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) {
        console.error(`[${runId.slice(0,8)}] Stack:`, err.stack);
      }

      if (isAbort || isUserInterrupt) {
        task.status = "cancelled";
        task.progress = "Cancelled";
        stream.send("done", { reason: "cancelled" });
      } else {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.progress = "Error";
        stream.send("error", { message: task.error });
      }
      task.finishedAt = new Date().toISOString();
    } finally {
      this.running.delete(runId);
      this.decrementConcurrency(task.tenantId);
      this.tasks.set(runId, task);

      if (!stream.isClosed) {
        stream.close();
      }
    }
  }

  private buildResult(
    stopReason: StopReason,
    usage: TokenUsage,
    toolCalls: number,
  ): AgentRunResult {
    const costUsd =
      (usage.inputTokens / 1_000_000) * 3 +
      (usage.outputTokens / 1_000_000) * 15;

    return {
      stopReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls,
      turns: 0, // Would need to track turns via AgentEvent
      costUsd: Math.round(costUsd * 10000) / 10000,
    };
  }

  private decrementConcurrency(tenantId: string): void {
    const current = this.tenantConcurrency.get(tenantId) ?? 0;
    if (current <= 1) {
      this.tenantConcurrency.delete(tenantId);
    } else {
      this.tenantConcurrency.set(tenantId, current - 1);
    }
  }
}
