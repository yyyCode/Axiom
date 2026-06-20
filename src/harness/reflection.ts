import { type Message, type AgentEvent } from "../types/index.js";
import { type BaseProvider, type TokenUsage } from "../providers/base.js";
import { type MemoryStore, type MemoryEntry } from "../memory/store.js";

// ─── Reflection Service ───────────────────────────────────────────

export interface ReflectionConfig {
  /** Provider for reflection calls (usually cheaper model) */
  provider: BaseProvider;
  /** Memory store to save learnings */
  memory: MemoryStore;
  /** Max tokens for reflection call */
  maxTokens?: number;
  /** Whether to run sync (blocking) or async */
  mode: "sync" | "async";
}

export interface ReflectionResult {
  /** Key learning points */
  learnings: string[];
  /** Suggested improvements */
  improvements: string[];
  /** Tags for categorization */
  tags: string[];
  /** Should this be saved to long-term memory? */
  worthRemembering: boolean;
  /** Summary for memory indexing */
  summary: string;
}

/**
 * Post-task reflection service.
 *
 * After each agent run, extracts learnings and saves them to memory.
 * This builds up a knowledge base that improves future runs.
 *
 * Flow:
 *   Agent completes task →
 *   ReflectionService analyzes conversation →
 *   Extract learnings + patterns →
 *   Save to memory store →
 *   Inject relevant memories into future System Prompts
 */
export class ReflectionService {
  private config: ReflectionConfig;
  private learnings: ReflectionResult[] = [];

  constructor(config: ReflectionConfig) {
    this.config = config;
  }

  /**
   * Run reflection on a completed task.
   *
   * @param messages - The full conversation history
   * @param taskDescription - Original task description
   * @param stopReason - Why the task stopped
   * @returns ReflectionResult with extracted learnings
   */
  async reflect(
    messages: Message[],
    taskDescription: string,
    stopReason: string,
  ): Promise<ReflectionResult> {
    const conversationSummary = this.summarizeConversation(messages);

    const prompt = `Review the following completed AI agent task and extract learnings.

<task>
${taskDescription}
</task>

<outcome>
Status: ${stopReason}
</outcome>

<conversation_summary>
${conversationSummary}
</conversation_summary>

Analyze:
1. What worked well? What strategies were effective?
2. What went wrong? What could have been done better?
3. Are there any patterns or reusable techniques?
4. What should be remembered for future similar tasks?

Respond with JSON:
{
  "learnings": ["learning 1", "learning 2", ...],
  "improvements": ["improvement 1", ...],
  "tags": ["tag1", "tag2", ...],
  "worthRemembering": true/false,
  "summary": "one-line summary for memory indexing"
}`;

    try {
      const result = await this.config.provider.call({
        messages: [{ role: "user", content: prompt }],
        system: "You are a task analysis AI. Output valid JSON only. Be specific and actionable.",
        tools: [],
        maxTokens: this.config.maxTokens ?? 1024,
      });

      console.log("[reflection] Raw response:", result.content.slice(0, 300));

      // Parse JSON — try multiple strategies
      let parsed: ReflectionResult | null = null;
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]) as ReflectionResult;
        } catch { /* try next strategy */ }
      }

      // Fallback: extract learnings from text
      if (!parsed || !parsed.learnings?.length) {
        parsed = this.extractLearningsFromText(result.content, taskDescription);
      }

      if (parsed.learnings.length > 0) {
        this.learnings.push(parsed);
        console.log("[reflection] Extracted:", parsed.learnings.length, "learnings,", parsed.tags?.length ?? 0, "tags");
      }

      // Save if there's anything worth remembering
      if (parsed.learnings.length > 0 && this.config.memory) {
        parsed.worthRemembering = true;
        await this.saveToMemory(parsed, taskDescription);
      }

      return parsed;
    } catch (err) {
      console.error("[reflection] Failed:", err instanceof Error ? err.message : String(err));
      return this.emptyResult();
    }
  }

  /**
   * Consolidate multiple reflections into higher-level insights.
   * Runs after accumulating N sessions (like Claude Code's Dream).
   */
  async consolidate(threshold = 5): Promise<string | null> {
    if (this.learnings.length < threshold) return null;

    const recent = this.learnings.slice(-threshold);

    const prompt = `Analyze these ${threshold} task reflections and identify cross-cutting patterns:

${recent.map((r, i) => `
### Task ${i + 1}
- Learnings: ${r.learnings.join("; ")}
- Improvements: ${r.improvements.join("; ")}
- Tags: ${r.tags.join(", ")}
`).join("\n")}

Identify:
1. Recurring themes across tasks
2. Common pitfalls the agent keeps hitting
3. Strategies that consistently work
4. A concise "rule" to add to the agent's system prompt

Output as: {"theme":"...", "pitfalls":[...], "winningStrategies":[...], "rule":"..."}`;

    try {
      const result = await this.config.provider.call({
        messages: [{ role: "user", content: prompt }],
        system: "You are a meta-analysis AI. Output valid JSON only.",
        tools: [],
        maxTokens: 1024,
      });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const consolidated = JSON.parse(jsonMatch[0]) as {
        theme: string;
        pitfalls: string[];
        winningStrategies: string[];
        rule: string;
      };

      // Save consolidated insight as a high-value memory
      if (consolidated.rule && this.config.memory) {
        await this.config.memory.save({
          name: `consolidated-${Date.now()}`,
          description: `Meta: ${consolidated.theme}`,
          type: "project",
          content: `**Theme:** ${consolidated.theme}

**Pitfalls to avoid:**
${consolidated.pitfalls.map((p) => `- ${p}`).join("\n")}

**Winning strategies:**
${consolidated.winningStrategies.map((s) => `- ${s}`).join("\n")}

**Rule:** ${consolidated.rule}`,
          metadata: {
            type: "consolidated",
            sourceCount: String(threshold),
            tags: "meta,consolidated",
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      // Reset accumulated learnings after consolidation
      this.learnings = [];

      return consolidated.rule;
    } catch (err) {
      console.error("[reflection] Consolidation failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Inject relevant memories into system prompt.
   * Call this before starting a new agent run.
   */
  async getRelevantMemories(
    taskDescription: string,
    maxMemories = 5,
  ): Promise<string> {
    try {
      const memories = await this.config.memory.search(taskDescription, maxMemories);
      if (memories.length === 0) return "";

      return `\n<learned_from_experience>\n${
        memories
          .map((m) => `- [${m.type}] ${m.description}: ${m.content.slice(0, 200)}`)
          .join("\n")
      }\n</learned_from_experience>\n`;
    } catch {
      return "";
    }
  }

  /** Get all accumulated learnings */
  getLearnings(): ReflectionResult[] {
    return [...this.learnings];
  }

  // ─── Private ─────────────────────────────────────────────────

  private async saveToMemory(
    result: ReflectionResult,
    taskDescription: string,
  ): Promise<void> {
    const entry: MemoryEntry = {
      name: `reflection-${Date.now()}`,
      description: result.summary || `Learning from: ${taskDescription.slice(0, 80)}`,
      type: "feedback",
      content: `**What worked:**\n${result.learnings.map((l) => `- ${l}`).join("\n")}

**What to improve:**\n${result.improvements.map((i) => `- ${i}`).join("\n")}

**Tags:** ${result.tags.join(", ")}`,
      metadata: {
        type: "reflection",
        tags: result.tags.join(","),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.config.memory.save(entry);
  }

  private summarizeConversation(messages: Message[]): string {
    const parts: string[] = [];
    let toolCalls = 0;
    let textOutput = "";

    for (const msg of messages) {
      if (msg.role === "assistant") {
        for (const block of msg.content) {
          if (block.type === "text") {
            textOutput += (block as { text: string }).text + " ";
          } else if (block.type === "tool_use") {
            toolCalls++;
          }
        }
      }
    }

    return `Tool calls: ${toolCalls}
Text output length: ${textOutput.length} chars
Preview: ${textOutput.slice(0, 500)}`;
  }

  /** Fallback: extract learnings from free-text LLM response */
  private extractLearningsFromText(text: string, taskDescription: string): ReflectionResult {
    const learnings: string[] = [];
    const improvements: string[] = [];
    const tags: string[] = [];

    // Heuristic extraction from bullet points or numbered lists
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*\d.]\s*/.test(trimmed)) {
        const content = trimmed.replace(/^[-*\d.]\s*/, "");
        if (content.length > 5) {
          if (/improve|fix|should|avoid|next time|better/i.test(content)) {
            improvements.push(content);
          } else {
            learnings.push(content);
          }
        }
      }
    }

    // Extract tags from common keywords
    const keywordMap: Record<string, string> = {
      "novel": "writing",
      "小说": "writing",
      "chapter": "writing",
      "video": "video",
      "code": "coding",
      "file": "file-ops",
      "tool": "tool-use",
    };
    for (const [keyword, tag] of Object.entries(keywordMap)) {
      if (text.toLowerCase().includes(keyword) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return {
      learnings: learnings.slice(0, 5),
      improvements: improvements.slice(0, 3),
      tags: tags.length > 0 ? tags : ["general"],
      worthRemembering: learnings.length > 0,
      summary: learnings[0] ?? taskDescription.slice(0, 80),
    };
  }

  private emptyResult(): ReflectionResult {
    return {
      learnings: [],
      improvements: [],
      tags: [],
      worthRemembering: false,
      summary: "",
    };
  }
}
