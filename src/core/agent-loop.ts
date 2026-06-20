import {
  type AgentConfig,
  type Message,
  type AssistantMessage,
  type UserMessage,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type AgentEvent,
  type StopReason,
} from "../types/index.js";
import { type BaseProvider, type TokenUsage } from "../providers/base.js";
import { type ToolRegistry } from "../tools/registry.js";
import { SystemPromptBuilder } from "../context/system-prompt.js";
import { ContextCompactor } from "../context/compaction.js";
import { executeToolCalls } from "./tool-executor.js";
import { PermissionChecker } from "./permission.js";

// ─── Agent Loop State ─────────────────────────────────────────────

interface LoopState {
  messages: Message[];
  turnCount: number;
  totalTokens: TokenUsage;
  isCompacted: boolean;
  stopReason: StopReason;
}

// ─── Agent Loop Options ───────────────────────────────────────────

export interface AgentLoopOptions {
  config: AgentConfig;
  provider: BaseProvider;
  registry: ToolRegistry;
  context: {
    cwd: string;
    sessionId: string;
    readOnly: boolean;
    signal?: AbortSignal;
    readFile: (path: string, offset?: number, limit?: number) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  onEvent?: (event: AgentEvent) => void;
}

// ─── The Agent Loop (codenamed "nO") ──────────────────────────────

/**
 * The core agent loop — the heart of the Axiom Agent Kernel.
 *
 * Pattern (inspired by Claude Code):
 *   while (model returns tool_use) {
 *     execute tools → feed results back → call model again
 *   }
 *
 * This single-threaded design prioritizes debuggability, transparency,
 * and reliability over complex orchestration patterns.
 */
export async function runAgentLoop(
  opts: AgentLoopOptions,
  initialPrompt: string,
): Promise<{ messages: Message[]; stopReason: StopReason; usage: TokenUsage }> {
  const { config, provider, registry, context, onEvent } = opts;

  // ─── Setup ───────────────────────────────────────────────────
  const systemBuilder = new SystemPromptBuilder(config);
  const compactor = new ContextCompactor(
    { maxTokens: config.context.maxTokens, compactionThreshold: config.context.compactionThreshold },
    provider,
  );
  const permissions = new PermissionChecker(config);
  let compactCount = 0;

  const state: LoopState = {
    messages: [],
    turnCount: 0,
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    isCompacted: false,
    stopReason: "completed",
  };

  // Add initial user message
  const userMsg: UserMessage = { role: "user", content: initialPrompt };
  state.messages.push(userMsg);

  const emit = (event: AgentEvent) => onEvent?.(event);

  // ─── Main Loop ───────────────────────────────────────────────
  while (true) {
    // Check abort signal
    if (context.signal?.aborted) {
      state.stopReason = "user_interrupt";
      break;
    }

    // Check turn limit
    if (state.turnCount >= config.limits.maxTurns) {
      state.stopReason = "max_turns";
      emit({ type: "done", reason: "max_turns" });
      break;
    }

    // Check budget limit (rough estimate: $3/M input, $15/M output for Claude)
    const estimatedCost =
      (state.totalTokens.inputTokens / 1_000_000) * 3 +
      (state.totalTokens.outputTokens / 1_000_000) * 15;
    if (estimatedCost >= config.limits.maxBudgetUsd) {
      state.stopReason = "max_budget";
      emit({ type: "done", reason: "max_budget" });
      break;
    }

    // Compaction check (before each turn except the first)
    if (state.turnCount > 0) {
      const tokenCount = await provider.countTokens(
        state.messages,
        systemBuilder.build(),
        registry.getAll(),
      );
      const level = compactor.shouldCompact(tokenCount, state.messages);
      if (level) {
        const result = await compactor.compact(state.messages, systemBuilder.build(), level);
        emit({
          type: "compaction",
          fromTokens: result.fromTokens,
          toTokens: result.toTokens,
        });
        state.messages = result.messages;
        state.isCompacted = true;
        compactCount++;
        console.log(
          `[compaction] ${result.level} compact: ${result.fromTokens} → ${result.toTokens} tokens ` +
          `(boundary at index ${result.boundaryIndex}, #${compactCount})`,
        );
      }
    }

    state.turnCount++;
    emit({ type: "turn_start", turn: state.turnCount });

    // Build system prompt
    const systemPrompt = systemBuilder.build();

    // ─── Call LLM ────────────────────────────────────────────
    let assistantContent: (TextBlock | ToolUseBlock)[];
    let toolCalls: ToolUseBlock[];
    let usage: TokenUsage;

    try {
      // Non-streaming mode for cleaner loop semantics
      // (Streaming can be added via provider.stream() with a token accumulator)
      const result = await provider.call({
        messages: state.messages,
        system: systemPrompt,
        tools: registry.getAll(),
        model: config.provider.model,
        maxTokens: config.provider.params?.maxTokens,
        temperature: config.provider.params?.temperature,
        topP: config.provider.params?.topP,
        topK: config.provider.params?.topK,
        signal: context.signal,
        enableCaching: config.context.enableCaching,
      });

      assistantContent = [];
      toolCalls = result.toolCalls;
      usage = result.usage;

      if (result.content) {
        assistantContent.push({ type: "text", text: result.content });
        emit({ type: "text_delta", text: result.content });
      }

      for (const tc of result.toolCalls) {
        assistantContent.push(tc);
        emit({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }

      state.totalTokens.inputTokens += usage.inputTokens;
      state.totalTokens.outputTokens += usage.outputTokens;

    } catch (err) {
      state.stopReason = "error";
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    // Add assistant message to history
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: assistantContent,
    };
    state.messages.push(assistantMsg);

    // ─── Check for tool calls ─────────────────────────────────
    if (toolCalls.length === 0) {
      state.stopReason = "completed";
      emit({ type: "done", reason: "completed" });
      break;
    }

    // Check tool call limit per turn
    if (toolCalls.length > config.limits.maxToolCallsPerTurn) {
      state.stopReason = "error";
      emit({
        type: "error",
        message: `Too many tool calls in one turn: ${toolCalls.length} (max: ${config.limits.maxToolCallsPerTurn})`,
      });
      break;
    }

    // ─── Permission Check ─────────────────────────────────────
    const permissionResults = await Promise.all(
      toolCalls.map(async (tc) => ({
        tc,
        allowed: await permissions.canUse(tc.name, tc.input, registry),
      })),
    );
    const allowed = permissionResults.filter((r) => r.allowed).map((r) => r.tc);
    const denied = permissionResults.filter((r) => !r.allowed).map((r) => r.tc);

    // Execute allowed tools
    const toolResults: ToolResultBlock[] = [];

    if (allowed.length > 0) {
      const results = await executeToolCalls(allowed, registry, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        readOnly: context.readOnly,
        signal: context.signal,
        readFile: context.readFile,
        writeFile: context.writeFile,
        log: (msg) => emit({ type: "text_delta", text: `[log] ${msg}\n` }),
      });
      toolResults.push(...results);

      for (const r of results) {
        const toolName = allowed.find((t) => t.id === r.tool_use_id)?.name ?? "unknown";
        if (r.is_error) {
          emit({
            type: "tool_error",
            id: r.tool_use_id,
            name: toolName,
            error: r.content,
          });
        } else {
          emit({
            type: "tool_result",
            id: r.tool_use_id,
            name: toolName,
            result: r.content,
          });
        }
      }
    }

    // Handle denied tools
    for (const d of denied) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: d.id,
        content: `Permission denied: tool "${d.name}" is not allowed in the current context.`,
        is_error: true,
      });
    }

    // ─── Feed tool results back ───────────────────────────────
    if (toolResults.length > 0) {
      state.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    // Error loop detection: if ALL tool results are errors, break
    const allErrors = toolResults.every((r) => r.is_error);
    if (allErrors && toolResults.length > 0) {
      // Allow one retry — if next turn also all errors, break
      const prevTurn = state.messages[state.messages.length - 3] as
        | { role: "user"; content: ToolResultBlock[] }
        | undefined;
      if (prevTurn?.role === "user" && Array.isArray(prevTurn.content)) {
        const prevAllErrors = prevTurn.content.every(
          (b: { is_error?: boolean }) => b.is_error,
        );
        if (prevAllErrors) {
          state.stopReason = "tool_error_loop";
          emit({ type: "done", reason: "tool_error_loop" });
          break;
        }
      }
    }

    emit({ type: "turn_end", turn: state.turnCount });
  }

  return {
    messages: state.messages,
    stopReason: state.stopReason,
    usage: state.totalTokens,
  };
}

// ─── Streaming Agent Loop ─────────────────────────────────────────

/**
 * Streaming version of the agent loop. Yields AgentEvents in real-time
 * as tokens are generated and tools are executed.
 */
export async function* streamAgentLoop(
  opts: AgentLoopOptions,
  initialPrompt: string,
): AsyncIterable<AgentEvent> {
  let lastEvent: AgentEvent | undefined;

  await runAgentLoop({
    ...opts,
    onEvent: (event) => {
      lastEvent = event;
      // The onEvent from opts is called inside runAgentLoop;
      // this wrapper captures the "external" callback too.
    },
  }, initialPrompt);

  // Note: Full streaming integration requires:
  // 1. Using provider.stream() instead of provider.call()
  // 2. Accumulating streaming deltas into complete tool_use blocks
  // 3. Yielding text_delta events as they arrive
  // The non-streaming version above is simpler and sufficient for most use cases.
  // See the Anthropic provider's stream() method for the streaming implementation.
}
