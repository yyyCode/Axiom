#!/usr/bin/env node
/**
 * Axiom CLI Agent — 命令行 AI 智能体
 *
 * 用法:
 *   axiom                   在当前目录启动 REPL
 *   axiom /path/to/project  在指定目录启动
 *   axiom "写一个函数..."   单次执行模式
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY        DeepSeek API 密钥
 *   OPENAI_API_KEY          OpenAI API 密钥 (可选)
 *   ANTHROPIC_API_KEY       Anthropic API 密钥 (可选)
 *   AXIOM_MODEL             模型名 (默认 deepseek-v4-flash)
 *   AXIOM_PROVIDER          Provider 类型 (默认 deepseek)
 */

import { resolve } from "node:path";
import { startREPL } from "./repl.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse args
  let cwd = process.cwd();
  let cliConfig: Partial<import("./config.js").CLIConfig> = {};

  // First arg: directory or prompt
  if (args.length > 0) {
    const first = args[0]!;
    // Check if it's a directory
    try {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(first));
      if (stat.isDirectory()) {
        cwd = resolve(first);
        // Shift remaining args as potential config
      } else {
        // It's a prompt — one-shot mode
        console.log("One-shot mode not yet implemented. Starting REPL instead.");
      }
    } catch {
      // Not a file — treat as prompt, fallback to REPL
      console.log("Starting REPL...");
    }
  }

  // Provider from env
  const providerType = process.env["AXIOM_PROVIDER"] as "deepseek" | "anthropic" | "openai" | undefined;
  if (providerType) {
    cliConfig.provider = {
      type: providerType,
      model: process.env["AXIOM_MODEL"] || getDefaultModel(providerType),
      apiKey: process.env[`${providerType.toUpperCase()}_API_KEY`] || "",
    };
  }

  await startREPL(cwd, cliConfig);
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "deepseek": return "deepseek-v4-flash";
    case "anthropic": return "claude-sonnet-4-6";
    case "openai": return "gpt-4o";
    default: return "deepseek-v4-flash";
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
