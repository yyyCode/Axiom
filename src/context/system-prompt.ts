import { type AgentConfig } from "../types/index.js";

// ─── System Prompt Builder ────────────────────────────────────────

/**
 * Assembles the system prompt from multiple sources.
 *
 * Architecture inspired by Claude Code's two-zone system:
 *  STATIC zone:  Base instructions + tool definitions (stable, cacheable)
 *  DYNAMIC zone: Context, memory, working directory (per-session, volatile)
 *
 * The boundary between zones is marked so providers can cache the static
 * portion while rebuilding the dynamic portion per-session.
 */
export class SystemPromptBuilder {
  private config: AgentConfig;
  private dynamicVariables: Map<string, string> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** Set dynamic variables (date, working directory, git status, etc.) */
  setVariable(key: string, value: string): this {
    this.dynamicVariables.set(key, value);
    return this;
  }

  setVariables(vars: Record<string, string>): this {
    for (const [k, v] of Object.entries(vars)) {
      this.dynamicVariables.set(k, v);
    }
    return this;
  }

  /** Build the complete system prompt */
  build(): string {
    const parts: string[] = [];

    // ─── STATIC ZONE ─────────────────────────────────────────
    parts.push(this.buildStaticZone());

    // ─── STATIC/DYNAMIC BOUNDARY ─────────────────────────────
    parts.push("<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->");

    // ─── DYNAMIC ZONE ────────────────────────────────────────
    parts.push(this.buildDynamicZone());

    return parts.join("\n\n");
  }

  /** Build just the static zone (stable, heavily cacheable) */
  buildStaticZone(): string {
    const parts: string[] = [];

    // Core identity and rules
    parts.push(`You are ${this.config.identity.name} — ${this.config.identity.description}.

<agent_rules>
1. You are an AI agent with access to tools. Use them to accomplish user tasks.
2. When you have enough information to act, act. Do not re-derive known facts.
3. Break complex tasks into smaller steps. Plan before executing.
4. Report outcomes truthfully: if something fails, say so with the output.
5. Prefer dedicated tools over shell commands when one fits.
6. Reference files and line numbers when discussing code.
7. When unsure, ask clarifying questions rather than guessing.
</agent_rules>

<tool_usage>
- Read-only tools execute concurrently for efficiency.
- State-mutating tools execute sequentially to avoid conflicts.
- When a mutating tool errors, sibling tools are skipped.
- Always validate tool inputs before execution.
</tool_usage>`);

    // Agent-specific instructions
    if (this.config.identity.instructions) {
      parts.push(`<agent_instructions>\n${this.config.identity.instructions}\n</agent_instructions>`);
    }

    return parts.join("\n\n");
  }

  /** Build the dynamic zone (per-session, volatile) */
  buildDynamicZone(): string {
    const parts: string[] = [];

    // Working directory
    const cwd = this.dynamicVariables.get("cwd");
    if (cwd) {
      parts.push(`<working_directory>${cwd}</working_directory>`);
    }

    // Current date
    const currentDate = this.dynamicVariables.get("date") ??
      new Date().toISOString().split("T")[0];
    parts.push(`<current_date>${currentDate}</current_date>`);

    // Platform info
    const platform = this.dynamicVariables.get("platform") ??
      `${process.platform} ${process.arch}`;
    parts.push(`<platform>${platform}</platform>`);

    // Session info
    const sessionId = this.dynamicVariables.get("sessionId");
    if (sessionId) {
      parts.push(`<session_id>${sessionId}</session_id>`);
    }

    // User preferences (injected from config)
    if (this.config.context.systemPromptAppend) {
      parts.push(this.config.context.systemPromptAppend);
    }

    return parts.join("\n");
  }
}
