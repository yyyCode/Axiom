import {
  type Message,
  type ToolDefinition,
  type JsonSchema,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../types/index.js";

// ─── Provider Interface ──────────────────────────────────────────

/** Streaming chunk from an LLM */
export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "content_block_start"; block: { type: string; id?: string; name?: string } }
  | { type: "tool_use_delta"; id: string; name: string; inputJson: string }
  | { type: "tool_use_complete"; block: ToolUseBlock }
  | { type: "message_stop"; stopReason: string; usage: TokenUsage }
  | { type: "error"; message: string };

/** Token usage statistics */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Options for an LLM call */
export interface ProviderCallOptions {
  messages: Message[];
  system: string;
  tools: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  signal?: AbortSignal;
  /** Enable prompt caching */
  enableCaching?: boolean;
}

/** Non-streaming LLM call result */
export interface ProviderCallResult {
  content: string;
  toolCalls: ToolUseBlock[];
  stopReason: string;
  usage: TokenUsage;
}

// ─── Abstract Base Provider ──────────────────────────────────────

export abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly defaultModel: string;

  /** Convert internal tool definition to provider-specific format */
  abstract formatTools(tools: ToolDefinition[]): unknown[];

  /** Format messages to provider-specific format */
  abstract formatMessages(messages: Message[]): unknown[];

  /** Non-streaming call */
  abstract call(opts: ProviderCallOptions): Promise<ProviderCallResult>;

  /** Streaming call — returns async iterable of chunks */
  abstract stream(
    opts: ProviderCallOptions,
  ): AsyncIterable<StreamChunk>;

  /** Count tokens for a set of messages (best-effort estimate) */
  abstract countTokens(
    messages: Message[],
    system: string,
    tools: ToolDefinition[],
  ): Promise<number>;

  /** Get tool JSON schemas — standardized across providers */
  extractToolSchemas(tools: ToolDefinition[]): JsonSchema[] {
    return tools.map((t) => t.jsonSchema);
  }
}

// ─── Provider imports (separate files, no re-export to avoid circular deps)
// Use import { AnthropicProvider } from "./anthropic.js"
// Use import { OpenAIProvider } from "./openai.js"
// Use import { createProvider } from "./factory.js"
