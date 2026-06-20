import { type Message, type ContentBlock } from "../types/index.js";
import { type BaseProvider } from "../providers/base.js";

// ─── Compaction Types ─────────────────────────────────────────────

export type CompactionLevel = "micro" | "auto" | "full";

export interface CompactionResult {
  messages: Message[];
  level: CompactionLevel;
  fromTokens: number;
  toTokens: number;
  /** Boundary index in messages array */
  boundaryIndex: number;
}

// ─── Token Estimator ──────────────────────────────────────────────

/** Fast token estimation without API call (4 chars ≈ 1 token) */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / 4);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          total += Math.ceil(((block as { text: string }).text).length / 4);
        } else if (block.type === "tool_use") {
          total += Math.ceil(JSON.stringify((block as { input: unknown }).input).length / 4) + 10;
        } else if (block.type === "tool_result") {
          total += Math.ceil(((block as { content: string }).content).length / 4) + 5;
        }
      }
    }
  }
  return total;
}

// ─── Context Compactor ────────────────────────────────────────────

/**
 * Three-layer context compaction, modeled after Claude Code.
 *
 * ┌─────────────────┬────────────┬──────────────────────────────┐
 * │ Layer           │ Trigger    │ Mechanism                    │
 * ├─────────────────┼────────────┼──────────────────────────────┤
 * │ MicroCompact    │ Any turn   │ Trim verbose tool outputs    │
 * │ AutoCompact     │ ~92% ctx   │ LLM-summarize older history  │
 * │ Full Compact    │ After fail │ Aggressive trim + re-inject  │
 * └─────────────────┴────────────┴──────────────────────────────┘
 */
export class ContextCompactor {
  private config: { maxTokens: number; compactionThreshold: number };
  private provider: BaseProvider;
  private consecutiveFailures = 0;
  private maxFailures = 3;

  constructor(
    config: { maxTokens: number; compactionThreshold: number },
    provider: BaseProvider,
  ) {
    this.config = config;
    this.provider = provider;
  }

  // ─── Public API ───────────────────────────────────────────────

  /** Check if any compaction level is needed */
  shouldCompact(currentTokens: number, messages: Message[]): CompactionLevel | null {
    const threshold = this.config.maxTokens * this.config.compactionThreshold;
    const criticalThreshold = this.config.maxTokens * 0.97;

    if (currentTokens >= criticalThreshold) return "full";
    if (currentTokens >= threshold) return "auto";
    if (this.shouldMicroCompact(messages)) return "micro";

    return null;
  }

  /**
   * Execute compaction at the appropriate level.
   * Returns compacted messages + metadata.
   */
  async compact(
    messages: Message[],
    systemPrompt: string,
    level?: CompactionLevel,
  ): Promise<CompactionResult> {
    const currentTokens = estimateTokens(messages);
    const effectiveLevel = level ?? this.shouldCompact(currentTokens, messages) ?? "auto";

    let result: CompactionResult;

    switch (effectiveLevel) {
      case "micro":
        result = this.microCompact(messages, currentTokens);
        break;
      case "auto":
        result = await this.autoCompact(messages, systemPrompt, currentTokens);
        break;
      case "full":
        result = await this.fullCompact(messages, systemPrompt, currentTokens);
        break;
    }

    return result;
  }

  // ─── Micro Compact ────────────────────────────────────────────

  /**
   * Trim verbose tool outputs. Zero API calls.
   * Cuts tool_result > 2000 chars down to 500 chars with a "[truncated]" note.
   */
  private microCompact(messages: Message[], currentTokens: number): CompactionResult {
    const compacted: Message[] = [];
    let trimmed = 0;

    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const blocks: ContentBlock[] = msg.content.map((block) => {
          if (block.type === "tool_result") {
            const tb = block as { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
            if (tb.content.length > 2000) {
              trimmed++;
              return {
                ...tb,
                content: tb.content.slice(0, 500) +
                  `\n\n[... truncated ${tb.content.length - 500} chars for context efficiency]`,
              };
            }
          }
          return block;
        });
        compacted.push({ ...msg, content: blocks } as Message);
      } else {
        compacted.push(msg);
      }
    }

    const toTokens = estimateTokens(compacted);

    return {
      messages: compacted,
      level: "micro",
      fromTokens: currentTokens,
      toTokens,
      boundaryIndex: compacted.length, // no boundary insertion for micro
    };
  }

  // ─── Auto Compact ─────────────────────────────────────────────

  /**
   * LLM-summarize older conversation history.
   *
   * Strategy:
   *  1. Find a safe split point (after a completed turn, not mid-tool-call)
   *  2. Keep the last 4-6 messages intact (continuity)
   *  3. Summarize everything before the split
   *  4. Insert a compact_boundary marker
   */
  private async autoCompact(
    messages: Message[],
    systemPrompt: string,
    currentTokens: number,
  ): Promise<CompactionResult> {
    if (messages.length <= 6) {
      return { messages, level: "auto", fromTokens: currentTokens, toTokens: currentTokens, boundaryIndex: 0 };
    }

    // Find safe split: look for a user message followed by assistant (completed turn)
    const splitIdx = this.findSafeSplitPoint(messages);
    const toSummarize = messages.slice(0, splitIdx);
    const recent = messages.slice(splitIdx);

    try {
      const summary = await this.summarize(toSummarize, systemPrompt);

      // Build compact_boundary system reminder
      const boundary: Message = {
        role: "user",
        content: `<system-reminder name="compact_boundary">
Context was compacted due to length. Previous conversation summarized below.

<summary>
${summary}
</summary>

Key information: files created/modified, important decisions, and task progress are preserved above.
The most recent context follows.
</system-reminder>`,
      };

      const compacted = [boundary, ...recent];
      const toTokens = estimateTokens(compacted);

      this.consecutiveFailures = 0;

      return {
        messages: compacted,
        level: "auto",
        fromTokens: currentTokens,
        toTokens,
        boundaryIndex: 1, // boundary is at index 0
      };
    } catch {
      return this.handleCompactionFailure(messages, currentTokens);
    }
  }

  // ─── Full Compact ─────────────────────────────────────────────

  /**
   * Aggressive compaction when context is critically full.
   * 1. First try auto compact
   * 2. If still too full, aggressively trim
   * 3. Re-inject critical context (task list, recent edits)
   */
  private async fullCompact(
    messages: Message[],
    systemPrompt: string,
    currentTokens: number,
  ): Promise<CompactionResult> {
    // Try auto compact first
    const autoResult = await this.autoCompact(messages, systemPrompt, currentTokens);
    if (autoResult.toTokens < this.config.maxTokens * 0.7) {
      return autoResult;
    }

    // Still too large: aggressively trim to last N messages
    const keepLast = Math.max(4, Math.floor(messages.length * 0.3));
    const trimmed = messages.slice(-keepLast);

    // Extract task-related messages to re-inject
    const taskMessages = this.extractCriticalContext(messages.slice(0, -keepLast));

    const compacted: Message[] = [
      ...taskMessages,
      {
        role: "user",
        content: "<system-reminder>Context was heavily compacted due to critical length. Only essential context and recent messages are preserved.</system-reminder>",
      },
      ...trimmed,
    ];

    const toTokens = estimateTokens(compacted);
    return {
      messages: compacted,
      level: "full",
      fromTokens: currentTokens,
      toTokens,
      boundaryIndex: taskMessages.length + 1,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /** Find a safe split point that doesn't break a tool-call → tool-result pair */
  private findSafeSplitPoint(messages: Message[]): number {
    // We want to keep the last ~4-6 messages, but ensure we don't split
    // between an assistant with tool_use and the subsequent tool_result
    const keepMin = Math.min(4, Math.floor(messages.length / 3));
    let idx = messages.length - keepMin;

    // Walk forward to find a safe boundary (user → assistant or end of tool_result group)
    while (idx < messages.length - 1) {
      const msg = messages[idx];
      const next = messages[idx + 1];

      if (!msg || !next) break;

      // Safe: current is tool_result (user), next is assistant
      if (msg.role === "user" && next.role === "assistant") {
        return idx + 1;
      }

      // Safe: current is assistant (no tool_use), next is user
      if (msg.role === "assistant" && next.role === "user") {
        return idx + 1;
      }

      idx++;
    }

    // Fallback: split at the middle
    return Math.floor(messages.length / 2);
  }

  /** Call LLM to summarize conversation history */
  private async summarize(messages: Message[], _systemPrompt: string): Promise<string> {
    const conversation = messages.map((m) => {
      const role = m.role;
      if (typeof m.content === "string") return `${role}: ${m.content.slice(0, 300)}`;

      return m.content
        .map((block) => {
          if (block.type === "text") return `${role}: ${(block as { text: string }).text.slice(0, 200)}`;
          if (block.type === "tool_use") {
            const tu = block as { name: string; input: unknown };
            return `${role}: [tool_use] ${tu.name}(${JSON.stringify(tu.input).slice(0, 100)})`;
          }
          if (block.type === "tool_result") {
            const tr = block as { content: string };
            return `[tool_result] ${tr.content.slice(0, 150)}`;
          }
          return `[${block.type}]`;
        })
        .join("\n");
    }).join("\n");

    const result = await this.provider.call({
      messages: [{
        role: "user",
        content: `Summarize this conversation segment. Include:
- Task progression (what was accomplished)
- Files created or modified
- Key decisions made
- Current task state
- Any errors encountered

<conversation>
${conversation.slice(-8000)}
</conversation>`,
      }],
      system: "You are compressing conversation history. Be concise, factual, and structured. Preserve technical details.",
      tools: [],
      maxTokens: 2048,
    });

    return result.content || "(summarized)";
  }

  /** Extract task management messages to preserve during full compaction */
  private extractCriticalContext(messages: Message[]): Message[] {
    const critical: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        // Preserve task_create and task_update tool results
        const hasTaskOp = msg.content.some((block) => {
          if (block.type === "tool_result") {
            const content = (block as { content: string }).content;
            return content.includes("Task [") || content.includes("task_create");
          }
          return false;
        });
        if (hasTaskOp) critical.push(msg);
      }
    }

    return critical.slice(-2); // Keep at most 2 critical messages
  }

  /** Handle compaction failure with graceful degradation */
  private handleCompactionFailure(messages: Message[], currentTokens: number): CompactionResult {
    this.consecutiveFailures++;
    console.warn(`[compaction] Auto-compact failed (${this.consecutiveFailures}/${this.maxFailures})`);

    if (this.consecutiveFailures >= this.maxFailures) {
      console.warn("[compaction] Max failures reached. Doing simple trim.");
    }

    // Fallback: trim oldest half of messages
    const trimmed = messages.slice(-Math.floor(messages.length / 2));
    const note: Message = {
      role: "user",
      content: "<system-reminder>Context was trimmed. Some earlier context may be missing.</system-reminder>",
    };

    return {
      messages: [note, ...trimmed],
      level: "full",
      fromTokens: currentTokens,
      toTokens: estimateTokens(trimmed),
      boundaryIndex: 0,
    };
  }

  /** Quick check: are there verbose tool outputs to trim? */
  private shouldMicroCompact(messages: Message[]): boolean {
    let verboseCount = 0;
    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            if (((block as { content: string }).content).length > 2000) {
              verboseCount++;
            }
          }
        }
      }
    }
    return verboseCount >= 3;
  }
}

// Re-export for convenience
export { estimateTokens };
