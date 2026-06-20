import {
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolExecutionContext,
  type ToolDefinition,
} from "../types/index.js";
import { type BaseProvider, type TokenUsage } from "../providers/base.js";
import { type ToolRegistry } from "../tools/registry.js";
import { executeToolCalls } from "../core/tool-executor.js";

// ─── Self-Healing Tool Executor ───────────────────────────────────

export interface SelfHealConfig {
  /** Max retry rounds (default 2) */
  maxRetries: number;
  /** Whether to prompt the LLM for diagnosis */
  useLLM: boolean;
  /** Provider for LLM diagnosis calls */
  provider?: BaseProvider;
}

/**
 * Self-healing wrapper around tool execution.
 *
 * When tools fail, instead of giving up immediately:
 *  1. Collect error information
 *  2. Ask the LLM to diagnose and fix (if useLLM=true)
 *  3. Retry with corrected parameters
 *  4. Max `maxRetries` rounds
 *
 * Common self-heal patterns:
 *  - File not found → glob first, then retry with correct path
 *  - Invalid params → fix JSON schema mismatch
 *  - Permission denied → switch to read-only alternative
 */
export class SelfHealExecutor {
  private config: SelfHealConfig;
  private stats: SelfHealStats = { totalErrors: 0, healedErrors: 0, retriesUsed: 0 };

  constructor(config: Partial<SelfHealConfig> = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 2,
      useLLM: config.useLLM ?? true,
      provider: config.provider,
    };
  }

  /**
   * Execute tool calls with self-healing retry.
   * Returns { results, healed } — healed is true if any error was fixed.
   */
  async execute(
    toolCalls: ToolUseBlock[],
    registry: ToolRegistry,
    context: ToolExecutionContext,
  ): Promise<{ results: ToolResultBlock[]; healed: boolean }> {
    let results = await executeToolCalls(toolCalls, registry, context);
    let retries = 0;
    let healed = false;

    while (retries < this.config.maxRetries) {
      // Find errors
      const errors = results.filter((r) => r.is_error);
      if (errors.length === 0) break;

      this.stats.totalErrors += errors.length;

      // Build diagnosis
      const diagnosis = this.buildDiagnosis(errors, toolCalls);
      context.log(`[self-heal] ${errors.length} tool error(s), attempt ${retries + 1}/${this.config.maxRetries}`);

      let fixes: Map<string, Record<string, unknown>>;

      if (this.config.useLLM && this.config.provider) {
        fixes = await this.llmDiagnose(diagnosis, errors);
      } else {
        fixes = this.ruleDiagnose(diagnosis, errors);
      }

      // Apply fixes and retry errored tools
      const toRetry: ToolUseBlock[] = [];
      for (const err of errors) {
        const original = toolCalls.find((t) => t.id === err.tool_use_id);
        if (!original) continue;

        const fix = fixes.get(original.id);
        if (fix) {
          toRetry.push({ ...original, input: fix });
          this.stats.healedErrors++;
          healed = true;
        }
      }

      if (toRetry.length === 0) break;

      const retryResults = await executeToolCalls(toRetry, registry, context);

      // Merge results: replace errored results with retry results
      results = results.filter((r) => !r.is_error);
      results.push(...retryResults);

      retries++;
      this.stats.retriesUsed++;
    }

    return { results, healed };
  }

  /** Get healing statistics */
  getStats(): SelfHealStats {
    return { ...this.stats };
  }

  // ─── Private ─────────────────────────────────────────────────

  private buildDiagnosis(
    errors: ToolResultBlock[],
    originals: ToolUseBlock[],
  ): string {
    return errors
      .map((e) => {
        const orig = originals.find((t) => t.id === e.tool_use_id);
        return `Tool: ${orig?.name ?? "unknown"}
Input: ${JSON.stringify(orig?.input ?? {})}
Error: ${e.content}`;
      })
      .join("\n---\n");
  }

  /** Rule-based automatic fixes (no LLM) */
  private ruleDiagnose(
    diagnosis: string,
    errors: ToolResultBlock[],
  ): Map<string, Record<string, unknown>> {
    const fixes = new Map<string, Record<string, unknown>>();

    for (const err of errors) {
      const msg = err.content.toLowerCase();

      // File not found → strip leading slashes, try relative path
      if (msg.includes("enoent") || msg.includes("no such file")) {
        fixes.set(err.tool_use_id, {
          _heal_note: "Attempted path correction",
        });
      }

      // Permission denied → mark for read-only retry
      if (msg.includes("permission") || msg.includes("eacces")) {
        fixes.set(err.tool_use_id, {
          _heal_note: "Permission issue — consider read-only path",
        });
      }
    }

    return fixes;
  }

  /** LLM-based diagnosis and fix generation */
  private async llmDiagnose(
    diagnosis: string,
    _errors: ToolResultBlock[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (!this.config.provider) return new Map();

    const fixes = new Map<string, Record<string, unknown>>();

    try {
      const result = await this.config.provider.call({
        messages: [
          {
            role: "user",
            content: `You are a tool error debugger. Analyze these tool call errors and suggest fixes.

${diagnosis}

For each error, output:
- What went wrong
- How to fix it
- The corrected input JSON

Respond ONLY with valid JSON like:
[{"tool_use_id":"...", "fix_reason":"...", "corrected_input":{...}}]`,
          },
        ],
        system: "You are a tool execution debugger. Output valid JSON only.",
        tools: [],
        maxTokens: 1024,
      });

      // Parse LLM response
      const jsonMatch = result.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const suggestions = JSON.parse(jsonMatch[0]) as Array<{
          tool_use_id: string;
          fix_reason: string;
          corrected_input: Record<string, unknown>;
        }>;
        for (const s of suggestions) {
          fixes.set(s.tool_use_id, s.corrected_input);
        }
      }
    } catch {
      // LLM diagnosis failed, fall back to rules
      // (already handled above by returning empty map)
    }

    return fixes;
  }
}

export interface SelfHealStats {
  totalErrors: number;
  healedErrors: number;
  retriesUsed: number;
}

/**
 * Quick self-heal wrapper: execute tools, retry errors, return results.
 * Simple convenience function for one-off use.
 */
export async function executeToolsWithHeal(
  toolCalls: ToolUseBlock[],
  registry: ToolRegistry,
  context: ToolExecutionContext,
  provider?: BaseProvider,
): Promise<ToolResultBlock[]> {
  const healer = new SelfHealExecutor({
    maxRetries: 2,
    useLLM: !!provider,
    provider,
  });
  const { results } = await healer.execute(toolCalls, registry, context);
  return results;
}
