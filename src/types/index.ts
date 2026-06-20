import { z } from "zod";

// ─── Messages ───────────────────────────────────────────────────

/** Base message type following the conversation API pattern */
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextBlock | ToolUseBlock)[];
}

export interface ToolResultMessage {
  role: "user";
  content: ToolResultBlock[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ─── Content Blocks ─────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

// ─── Tool Definitions ────────────────────────────────────────────

/** Zod schema or plain JSON Schema object */
export type ToolInputSchema = z.ZodObject<z.ZodRawShape>;

/** JSON Schema representation (derived from Zod) */
export interface JsonSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string };
  }>;
  required?: string[];
}

/** Tool definition — the core unit of agent capability */
export interface ToolDefinition {
  /** Unique tool name (snake_case convention) */
  name: string;
  /** Description shown to the LLM for tool selection */
  description: string;
  /** Zod schema for input validation */
  schema: z.ZodObject<z.ZodRawShape>;
  /** JSON Schema derived from Zod for LLM tool_use */
  jsonSchema: JsonSchema;
  /** Execution handler — receives validated input from LLM tool_use */
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
  /** Whether this tool mutates state (serial execution) */
  isMutating: boolean;
  /** Risk level for permission system */
  riskLevel: ToolRiskLevel;
  /** Custom permission check (optional, overrides default) */
  permission?: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<boolean>;
}

/** Tool execution context provided to every tool */
export interface ToolExecutionContext {
  /** Working directory */
  cwd: string;
  /** Current session ID */
  sessionId: string;
  /** Read-only flag — if true, mutating tools should refuse */
  readOnly: boolean;
  /** Hook for abort signal */
  signal?: AbortSignal;
  /** Read a file (convenience for tools) */
  readFile(path: string, offset?: number, limit?: number): Promise<string>;
  /** Write a file (convenience) */
  writeFile(path: string, content: string): Promise<void>;
  /** Logger */
  log(message: string): void;
}

/** Result of tool execution */
export interface ToolResult {
  /** Text content to feed back to the LLM */
  content: string;
  /** If true, the LLM is told this was an error */
  isError?: boolean;
  /** Arbitrary structured data (for programmatic consumers) */
  data?: unknown;
}

// ─── Tool Risk ───────────────────────────────────────────────────

/** Risk classification for permission system */
export type ToolRiskLevel = "readonly" | "safe" | "dangerous";

// ─── Agent Configuration ─────────────────────────────────────────

/** Full agent configuration */
export interface AgentConfig {
  /** Agent identity */
  identity: {
    name: string;
    description: string;
    /** Path to agent-specific instructions file (CLAUDE.md style) */
    instructionsPath?: string;
    /** Inline instructions */
    instructions?: string;
  };

  /** LLM provider config */
  provider: ProviderConfig;

  /** Tool configuration */
  tools: ToolConfig;

  /** Context management */
  context: ContextConfig;

  /** Session settings */
  session: SessionConfig;

  /** Memory settings */
  memory: MemoryConfig;

  /** Execution limits */
  limits: LimitsConfig;

  /** Subagent configuration */
  subagents: SubAgentConfig;
}

export interface ProviderConfig {
  /** Provider type */
  type: ProviderType;
  /** API key (or env var name) */
  apiKey?: string;
  /** API base URL override */
  baseUrl?: string;
  /** Default model */
  model: string;
  /** Model parameters */
  params?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
  };
}

export type ProviderType = "anthropic" | "openai" | "deepseek" | "custom";

export interface ToolConfig {
  /** Built-in tools to enable */
  builtin: BuiltinToolSet[];
  /** Custom tools registered by the application */
  custom: ToolDefinition[];
  /** Whether to allow the LLM to request new tool creation */
  allowDynamicTools: boolean;
}

export type BuiltinToolSet =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "glob"
  | "grep"
  | "bash"
  | "web_search"
  | "web_fetch"
  | "sub_agent"
  | "task_management"
  | "ask_user";

export interface ContextConfig {
  /** Max tokens before triggering compaction */
  maxTokens: number;
  /** Compaction threshold (fraction of maxTokens, e.g. 0.92) */
  compactionThreshold: number;
  /** System prompt template — may include {{variables}} */
  systemPromptTemplate?: string;
  /** Custom system prompt appending */
  systemPromptAppend?: string;
  /** Whether to inject CLAUDE.md-style file */
  injectInstructions: boolean;
  /** Enable prefix caching */
  enableCaching: boolean;
}

export interface SessionConfig {
  /** Maximum turns per session */
  maxTurns: number;
  /** Maximum budget in USD */
  maxBudgetUsd: number;
  /** Session persistence directory */
  persistPath?: string;
  /** Auto-resume from last session */
  autoResume: boolean;
  /** Max session duration in minutes */
  maxDurationMinutes: number;
}

export interface MemoryConfig {
  /** Memory storage directory */
  storagePath: string;
  /** Enable structured memory (SQLite) */
  enableStructured: boolean;
  /** Max memory files to auto-load */
  maxAutoLoad: number;
  /** Memory consolidation trigger: sessions count */
  consolidateAfterSessions: number;
}

export interface LimitsConfig {
  maxTurns: number;
  maxBudgetUsd: number;
  maxToolCallsPerTurn: number;
  maxSubAgents: number;
  maxSubAgentDepth: number;
}

export interface SubAgentConfig {
  /** Enable subagent spawning */
  enabled: boolean;
  /** Max depth of subagent nesting */
  maxDepth: number;
  /** Default model for subagents (or inherit) */
  model?: string;
  /** Tools available to subagents */
  tools: ToolDefinition[];
}

// ─── Stream Types ────────────────────────────────────────────────

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string }
  | { type: "tool_error"; id: string; name: string; error: string }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "compaction"; fromTokens: number; toTokens: number }
  | { type: "error"; message: string }
  | { type: "done"; reason: StopReason }
  | { type: "subagent_start"; id: string; description: string }
  | { type: "subagent_done"; id: string; result: string };

export type StopReason =
  | "completed"
  | "max_turns"
  | "max_budget"
  | "user_interrupt"
  | "error"
  | "tool_error_loop";

// ─── SubAgent Types ──────────────────────────────────────────────

export interface SubAgentSpec {
  id: string;
  description: string;
  prompt: string;
  tools?: ToolDefinition[];
  model?: string;
  maxTurns?: number;
  /** Isolation mode: "inline" (same context) or "isolated" (fresh context) */
  isolation: "inline" | "isolated";
}

export interface SubAgentResult {
  id: string;
  output: string;
  toolCalls: number;
  turns: number;
  tokensUsed: number;
}
