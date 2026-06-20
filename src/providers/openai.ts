import OpenAI from "openai";
import {
  BaseProvider,
  type ProviderCallOptions,
  type ProviderCallResult,
  type StreamChunk,
} from "./base.js";
import type { Message, ToolDefinition, ToolUseBlock } from "../types/index.js";

export class OpenAIProvider extends BaseProvider {
  readonly name = "openai";
  readonly defaultModel = "gpt-4o";
  private client: OpenAI;

  constructor(opts: { apiKey?: string; baseUrl?: string }) {
    super();
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: opts.baseUrl,
    });
  }

  formatTools(
    tools: ToolDefinition[],
  ): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema as unknown as Record<string, unknown>,
      },
    }));
  }

  formatMessages(
    messages: Message[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const formatted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const m of messages) {
      if (m.role === "user") {
        if (Array.isArray(m.content)) {
          // Tool results
          for (const block of m.content) {
            if (block.type === "tool_result") {
              formatted.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: block.content,
              });
            } else if (block.type === "text") {
              formatted.push({ role: "user", content: block.text });
            }
          }
        } else {
          formatted.push({ role: "user", content: m.content });
        }
      }

      if (m.role === "assistant") {
        const textBlocks = m.content.filter((b) => b.type === "text");
        const toolCalls = m.content.filter(
          (b) => b.type === "tool_use",
        ) as ToolUseBlock[];

        const textContent = textBlocks.map((b) => (b as { text: string }).text).join("");

        formatted.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input),
                },
              }))
            : undefined,
        });
      }
    }

    return formatted;
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      top_p: opts.topP,
      messages: [
        { role: "system", content: opts.system },
        ...this.formatMessages(opts.messages),
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: opts.tools.length > 0 ? this.formatTools(opts.tools) : undefined,
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    const toolCalls: ToolUseBlock[] = [];
    let textContent = "";

    if (choice?.message) {
      if (choice.message.content) {
        textContent = choice.message.content;
      }
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          toolCalls.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
      }
    }

    return {
      content: textContent,
      toolCalls,
      stopReason: choice?.finish_reason ?? "stop",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *stream(opts: ProviderCallOptions): AsyncIterable<StreamChunk> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      top_p: opts.topP,
      messages: [
        { role: "system", content: opts.system },
        ...this.formatMessages(opts.messages),
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: opts.tools.length > 0 ? this.formatTools(opts.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };

    const stream = this.client.chat.completions.create(params);
    // OpenAI streaming tool calls need accumulation
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of await stream) {
      const choice = (chunk as OpenAI.Chat.Completions.ChatCompletionChunk).choices[0];
      const delta = choice?.delta;

      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const existing = toolCallAccumulators.get(idx);
          if (existing) {
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
          } else {
            toolCallAccumulators.set(idx, {
              id: tc.id ?? `tool_${idx}`,
              name: tc.function?.name ?? "",
              args: tc.function?.arguments ?? "",
            });
          }
        }
      }

      // On finish, emit complete tool calls
      if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "stop") {
        for (const [, acc] of toolCallAccumulators) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(acc.args); } catch { /* ok */ }
          yield {
            type: "tool_use_complete",
            block: {
              type: "tool_use",
              id: acc.id,
              name: acc.name,
              input,
            },
          };
        }
        toolCallAccumulators.clear();

        yield {
          type: "message_stop",
          stopReason: choice!.finish_reason ?? "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        };
      }
    }
  }

  async countTokens(
    messages: Message[],
    system: string,
    _tools: ToolDefinition[],
  ): Promise<number> {
    // OpenAI doesn't expose token counting easily; use heuristic
    let text = system;
    for (const m of messages) {
      if (typeof m.content === "string") text += m.content;
      else text += JSON.stringify(m.content);
    }
    return Math.ceil(text.length / 4);
  }
}
