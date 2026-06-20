import {
  type ToolDefinition,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolExecutionContext,
  type ToolResult,
} from "../types/index.js";
import { type ToolRegistry } from "../tools/registry.js";

// ─── Tool Execution Strategy ──────────────────────────────────────

/**
 * Execute tools with the Claude Code strategy:
 * - Read-only tools run CONCURRENTLY (parallel)
 * - State-mutating tools run SEQUENTIALLY (must not conflict)
 * - Bash errors cancel sibling tools
 */
export async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  registry: ToolRegistry,
  context: ToolExecutionContext,
): Promise<ToolResultBlock[]> {
  if (toolCalls.length === 0) return [];

  // Separate read-only from mutating tools
  const readOnly: ToolUseBlock[] = [];
  const mutating: ToolUseBlock[] = [];

  for (const tc of toolCalls) {
    const tool = registry.get(tc.name);
    if (tool?.isMutating) {
      mutating.push(tc);
    } else {
      readOnly.push(tc);
    }
  }

  const results: ToolResultBlock[] = [];

  // 1. Execute read-only tools in parallel
  if (readOnly.length > 0) {
    const parallelResults = await Promise.all(
      readOnly.map((tc) => executeSingleTool(tc, registry, context)),
    );
    results.push(...parallelResults);
  }

  // 2. Execute mutating tools sequentially
  for (const tc of mutating) {
    const result = await executeSingleTool(tc, registry, context);
    results.push(result);

    // If a mutating tool errors, stop executing siblings
    if (result.is_error) {
      // Mark remaining mutating tools as skipped
      for (const remaining of mutating.slice(mutating.indexOf(tc) + 1)) {
        results.push({
          type: "tool_result",
          tool_use_id: remaining.id,
          content: `Skipped: previous tool "${tc.name}" failed with error.`,
          is_error: true,
        });
      }
      break;
    }
  }

  return results;
}

async function executeSingleTool(
  toolCall: ToolUseBlock,
  registry: ToolRegistry,
  context: ToolExecutionContext,
): Promise<ToolResultBlock> {
  const startTime = Date.now();

  const result: ToolResult = await registry.execute(
    toolCall.name,
    toolCall.input,
    context,
  );

  const elapsed = Date.now() - startTime;
  context.log(
    `[tool] ${toolCall.name} completed in ${elapsed}ms ${result.isError ? "(error)" : ""}`,
  );

  return {
    type: "tool_result",
    tool_use_id: toolCall.id,
    content: result.content,
    is_error: result.isError,
  };
}
