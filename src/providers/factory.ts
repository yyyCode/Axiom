import { BaseProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export interface ProviderConfig {
  type: "anthropic" | "openai" | "deepseek" | "custom";
  apiKey?: string;
  baseUrl?: string;
  /** Override the default model for this provider instance */
  defaultModel?: string;
  /** For custom providers: an implementation of BaseProvider */
  customProvider?: BaseProvider;
}

/**
 * Create a provider instance from configuration.
 *
 * Supports Anthropic, OpenAI, DeepSeek (OpenAI-compatible), and custom.
 */
export function createProvider(config: ProviderConfig): BaseProvider {
  let provider: BaseProvider;

  switch (config.type) {
    case "anthropic":
      provider = new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      break;

    case "openai":
      provider = new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      break;

    case "deepseek":
      // DeepSeek uses an OpenAI-compatible API
      provider = new OpenAIProvider({
        apiKey: config.apiKey ?? process.env["DEEPSEEK_API_KEY"],
        baseUrl: config.baseUrl ?? "https://api.deepseek.com/v1",
      });
      break;

    case "custom":
      if (!config.customProvider) {
        throw new Error("custom provider type requires a customProvider instance");
      }
      provider = config.customProvider;
      break;

    default:
      throw new Error(`Unknown provider type: ${config["type"]}`);
  }

  // Override default model if specified
  if (config.defaultModel) {
    (provider as { defaultModel: string }).defaultModel = config.defaultModel;
  }

  return provider;
}
