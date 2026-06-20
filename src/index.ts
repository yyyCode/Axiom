/**
 * Axiom Agent Kernel
 *
 * A通用Agent内核，仿照Claude Code架构实现。
 * 可用于小说生成Agent、视频生成Agent等场景。
 *
 * @packageDocumentation
 */

// ─── Types ────────────────────────────────────────────────────────
export type {
  // Messages
  Message,
  UserMessage,
  AssistantMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,

  // Tools
  ToolDefinition,
  ToolInputSchema,
  ToolExecutionContext,
  ToolResult,
  ToolRiskLevel,
  ToolConfig,
  BuiltinToolSet,
  JsonSchema,

  // Agent
  AgentConfig,
  AgentEvent,
  StopReason,
  ProviderConfig,
  ProviderType,
  ContextConfig,
  SessionConfig,
  MemoryConfig,
  LimitsConfig,
  SubAgentConfig,

  // SubAgent
  SubAgentSpec,
  SubAgentResult,
} from "./types/index.js";

// ─── Core ─────────────────────────────────────────────────────────
export {
  runAgentLoop,
  streamAgentLoop,
  executeToolCalls,
  PermissionChecker,
  SubAgentManager,
} from "./core/index.js";

export type { AgentLoopOptions, PermissionMode } from "./core/index.js";

// ─── Providers ────────────────────────────────────────────────────
export { BaseProvider } from "./providers/base.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
export { createProvider } from "./providers/factory.js";

export type {
  StreamChunk,
  TokenUsage,
  ProviderCallOptions,
  ProviderCallResult,
} from "./providers/base.js";

// ─── Tools ────────────────────────────────────────────────────────
export {
  ToolRegistry,
  globalRegistry,
  defineTool,
  zodToJsonSchema,
  resolveTools,
  builtinToolMap,
} from "./tools/index.js";

export type { ToolBuilderOpts } from "./tools/index.js";

// ─── Context ──────────────────────────────────────────────────────
export {
  SystemPromptBuilder,
  ContextCompactor,
} from "./context/index.js";

// ─── Memory ───────────────────────────────────────────────────────
export {
  FileMemoryStore,
  SqliteMemoryStore,
} from "./memory/index.js";

export type {
  MemoryStore,
  MemoryEntry,
  StructuredMemoryStore,
  StructuredEntity,
  EntityRelationship,
} from "./memory/index.js";

// ─── Session ──────────────────────────────────────────────────────
export {
  SessionManager,
} from "./session/index.js";

export type {
  Session,
  SessionMetadata,
  SessionSummary,
} from "./session/index.js";

// ─── Stream ───────────────────────────────────────────────────────
import type { AgentEvent as StreamEventType } from "./types/index.js";
/** Stream event emitted during agent execution */
export type StreamEvent = StreamEventType;
