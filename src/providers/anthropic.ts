import Anthropic from "@anthropic-ai/sdk";
import {
  BaseProvider,
  type ProviderCallOptions,
  type ProviderCallResult,
  type StreamChunk,
} from "./base.js";
import type { Message, ToolDefinition, ToolUseBlock } from "../types/index.js";

export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  readonly defaultModel = "claude-sonnet-4-6";
  private client: Anthropic;

  constructor(opts: { apiKey?: string; baseUrl?: string }) {
    super();
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: opts.baseUrl,
    });
  }

  formatTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
    }));
  }

  formatMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (m.role === "user") {
        if (Array.isArray(m.content)) {
          return {
            role: "user",
            content: m.content.map((block) => {
              if (block.type === "tool_result") {
                return {
                  type: "tool_result" as const,
                  tool_use_id: block.tool_use_id,
                  content: block.content,
                  is_error: block.is_error,
                };
              }
              return { type: "text" as const, text: JSON.stringify(block) };
            }),
          };
        }
        return { role: "user", content: m.content };
      }
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content.map((block) => {
            if (block.type === "tool_use") {
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input as Record<string, Anthropic.ToolUseBlockParam["input"]>,
              };
            }
            return { type: "text" as const, text: block.text };
          }),
        };
      }
      return { role: "user", content: "(empty)" };
    });
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const response = await this.client.messages.create({
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      top_p: opts.topP,
      top_k: opts.topK,
      system: opts.system,
      messages: this.formatMessages(opts.messages) as Anthropic.MessageParam[],
      tools: opts.tools.length > 0 ? this.formatTools(opts.tools) : undefined,
    });

    const toolCalls: ToolUseBlock[] = [];
    let textContent = "";

    for (const block of response.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: textContent,
      toolCalls,
      stopReason: response.stop_reason ?? "end_turn",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }

  async *stream(opts: ProviderCallOptions): AsyncIterable<StreamChunk> {
    const stream = this.client.messages.stream({
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      top_p: opts.topP,
      top_k: opts.topK,
      system: opts.system,
      messages: this.formatMessages(opts.messages) as Anthropic.MessageParam[],
      tools: opts.tools.length > 0 ? this.formatTools(opts.tools) : undefined,
    });

    let currentToolId = "";
    let currentToolName = "";
    let currentToolInput = "";

    for await (const event of stream) {
      const raw = event as {
        type: string;
        text?: string;
        content_block?: { type: string; id?: string; name?: string; text?: string };
        delta?: { type: string; text?: string; partial_json?: string };
        message?: { usage: { input_tokens: number; output_tokens: number } };
        error?: { message: string };
      };

      switch (raw.type) {
        case "text":
          yield { type: "text_delta", text: raw.text ?? "" };
          break;

        case "content_block_start":
          if (raw.content_block?.type === "tool_use") {
            currentToolId = raw.content_block.id ?? "";
            currentToolName = raw.content_block.name ?? "";
            currentToolInput = "";
            yield {
              type: "content_block_start",
              block: { type: "tool_use", id: currentToolId, name: currentToolName },
            };
          } else {
            yield {
              type: "content_block_start",
              block: { type: raw.content_block?.type ?? "text" },
            };
          }
          break;

        case "content_block_delta":
          if (raw.delta?.type === "input_json_delta") {
            currentToolInput += raw.delta.partial_json ?? "";
            yield {
              type: "tool_use_delta",
              id: currentToolId,
              name: currentToolName,
              inputJson: raw.delta.partial_json ?? "",
            };
          } else if (raw.delta?.type === "text_delta") {
            yield { type: "text_delta", text: raw.delta.text ?? "" };
          }
          break;

        case "content_block_stop":
          if (currentToolId) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(currentToolInput);
            } catch { /* best-effort parse */ }
            yield {
              type: "tool_use_complete",
              block: {
                type: "tool_use",
                id: currentToolId,
                name: currentToolName,
                input: parsedInput,
              },
            };
            currentToolId = "";
            currentToolName = "";
            currentToolInput = "";
          }
          break;

        case "message_stop":
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: {
              inputTokens: raw.message?.usage.input_tokens ?? 0,
              outputTokens: raw.message?.usage.output_tokens ?? 0,
            },
          };
          break;

        case "error":
          yield { type: "error", message: raw.error?.message ?? "Unknown error" };
          break;
      }
    }
  }

  async countTokens(
    messages: Message[],
    system: string,
    tools: ToolDefinition[],
  ): Promise<number> {
    try {
      const result = await this.client.messages.countTokens({
        model: this.defaultModel,
        system: system,
        messages: this.formatMessages(messages) as Anthropic.MessageParam[],
        tools: tools.length > 0 ? this.formatTools(tools) : undefined,
      } as unknown as Anthropic.MessageCountTokensParams);
      return result.input_tokens;
    } catch {
      // Fallback: rough estimate (4 chars ≈ 1 token)
      let text = system;
      for (const m of messages) {
        if (typeof m.content === "string") text += m.content;
        else text += JSON.stringify(m.content);
      }
      return Math.ceil(text.length / 4);
    }
  }
}
