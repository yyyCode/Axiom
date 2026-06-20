import { BaseProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export interface ProviderConfig {
  type: "anthropic" | "openai" | "deepseek" | "custom";
  apiKey?: string;
  baseUrl?: string;
  /** For custom providers: an implementation of BaseProvider */
  customProvider?: BaseProvider;
}

/**
 * Create a provider instance from configuration.
 *
 * Supports Anthropic, OpenAI, DeepSeek (OpenAI-compatible), and custom.
 */
export function createProvider(config: ProviderConfig): BaseProvider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

    case "deepseek":
      // DeepSeek uses an OpenAI-compatible API
      return new OpenAIProvider({
        apiKey: config.apiKey ?? process.env["DEEPSEEK_API_KEY"],
        baseUrl: config.baseUrl ?? "https://api.deepseek.com/v1",
      });

    case "custom":
      if (!config.customProvider) {
        throw new Error("custom provider type requires a customProvider instance");
      }
      return config.customProvider;

    default:
      throw new Error(`Unknown provider type: ${config["type"]}`);
  }
}
