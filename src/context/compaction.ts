import { type AgentConfig, type Message } from "../types/index.js";
import { type BaseProvider } from "../providers/base.js";

// ─── Context Compactor ────────────────────────────────────────────

/**
 * Three-layer context compaction system.
 *
 * Inspired by Claude Code's compaction cascade:
 *  - MicroCompact: trim redundant tool outputs (zero API calls)
 *  - AutoCompact: LLM-summarize older history (~92% threshold)
 *  - Full Compact: aggressive compression with re-injection
 */
export class CompactionThreshold {
  static readonly DEFAULT = 0.92;
  static readonly AGGRESSIVE = 0.80;
  static readonly CRITICAL = 0.95;
}

export class ContextCompactor {
  private config: AgentConfig;
  private provider: BaseProvider;

  constructor(config: AgentConfig, provider: BaseProvider) {
    this.config = config;
    this.provider = provider;
  }

  /** Determine if compaction is needed */
  shouldCompact(
    currentTokens: number,
    _messages: Message[],
  ): boolean {
    const threshold = this.config.context.maxTokens *
      (this.config.context.compactionThreshold || CompactionThreshold.DEFAULT);
    return currentTokens >= threshold;
  }

  /**
   * Compact the message history.
   *
   * Strategy:
   *  1. Keep the system prompt (not in messages)
   *  2. Keep the most recent N messages intact
   *  3. Summarize older messages via LLM call
   *  4. Replace old history with a synthetic summary message
   */
  async compact(
    messages: Message[],
    systemPrompt: string,
  ): Promise<Message[]> {
    // If history is short, don't compact
    if (messages.length <= 6) return messages;

    // Keep the last 4 messages intact (typically: user→assistant→tool_results→assistant)
    const keepCount = Math.min(4, Math.floor(messages.length / 2));
    const toSummarize = messages.slice(0, -keepCount);
    const recent = messages.slice(-keepCount);

    // Build summary prompt
    const summaryPrompt = this.buildSummaryPrompt(toSummarize);

    try {
      const result = await this.provider.call({
        messages: [{ role: "user", content: summaryPrompt }],
        system: "You are a conversation summarizer. Be concise and factual.",
        tools: [],
        maxTokens: 4096,
      });

      const summaryContent = result.content || "(conversation summarized)";

      // Replace old history with a synthetic summary message
      const summaryMessage: Message = {
        role: "user",
        content: `<system-reminder>Previous conversation summary (auto-compacted):\n${summaryContent}\n\nKey files and decisions from earlier in the conversation are listed above. The most recent context follows.\n</system-reminder>`,
      };

      return [summaryMessage, ...recent];
    } catch {
      // If compaction fails, trim the oldest messages
      const trimmed = messages.slice(-Math.floor(messages.length / 2));
      const note: Message = {
        role: "user",
        content: "<system-reminder>Context was trimmed due to length. Some earlier context may be missing.</system-reminder>",
      };
      return [note, ...trimmed];
    }
  }

  private buildSummaryPrompt(messages: Message[]): string {
    const conversation = messages.map((m) => {
      const role = m.role;
      const content = typeof m.content === "string"
        ? m.content
        : m.content.map((b) => {
            if (b.type === "text") return `[text] ${b.text.slice(0, 200)}`;
            if (b.type === "tool_use") return `[tool_use:${b.name}]`;
            if (b.type === "tool_result") return `[tool_result] ${(b as { content: string }).content.slice(0, 200)}`;
            return `[${b.type}]`;
          }).join(" ");
      return `${role}: ${content}`;
    }).join("\n");

    return `Summarize the key points from this conversation history. Include: important decisions made, files modified, key findings, and current task state. Be concise but complete.\n\n<conversation>\n${conversation}\n</conversation>`;
  }
}
