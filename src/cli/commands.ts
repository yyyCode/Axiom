import type { CLIConfig } from "./config.js";

// ─── Slash Commands ───────────────────────────────────────────────

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  /** Execute returns output text to display */
  execute: (args: string[], ctx: CommandContext) => string | Promise<string>;
}

export interface CommandContext {
  cwd: string;
  config: CLIConfig;
  sessionId: string;
  messageCount: number;
  totalTokens: { input: number; output: number };
  totalCost: number;
}

// ─── Built-in Commands ────────────────────────────────────────────

export function builtinCommands(): Command[] {
  return [helpCommand, clearCommand, compactCommand, memoryCommand, costCommand, modelCommand, toolsCommand, sessionCommand];
}

const helpCommand: Command = {
  name: "help",
  aliases: ["h", "?"],
  description: "Show available commands",
  usage: "/help [command]",
  execute: (_args, _ctx) => {
    const cmds = builtinCommands();
    return cmds.map((c) =>
      `  /${c.name.padEnd(12)} ${c.description}\n    usage: ${c.usage}`,
    ).join("\n");
  },
};

const clearCommand: Command = {
  name: "clear",
  aliases: ["cls"],
  description: "Clear the conversation history (start fresh)",
  usage: "/clear",
  execute: (_args, _ctx) => {
    return "Conversation cleared. New session will start on next prompt.";
  },
};

const compactCommand: Command = {
  name: "compact",
  aliases: ["compress"],
  description: "Manually trigger context compaction (summarizes older messages)",
  usage: "/compact",
  execute: (_args, ctx) => {
    const estTokens = ctx.totalTokens.input + ctx.totalTokens.output;
    if (estTokens < 50000) {
      return `Context is small (~${estTokens} tokens). Compaction not needed yet. Auto-compacts at ~92% window.`;
    }
    return `Requesting compaction... (~${estTokens} tokens). Use this when the conversation feels slow or responses degrade.`;
  },
};

const memoryCommand: Command = {
  name: "memory",
  aliases: ["mem"],
  description: "View or manage agent memory",
  usage: "/memory [list|search <query>]",
  execute: async (args, ctx) => {
    const { FileMemoryStore } = await import("../memory/file-store.js");
    const store = new FileMemoryStore(ctx.config.session.persistPath + "/../memory");
    await store.init();

    const sub = args[0] || "list";
    if (sub === "search" && args[1]) {
      const results = await store.search(args[1], 5);
      if (results.length === 0) return "No matching memories found.";
      return results.map((m) => `[${m.type}] ${m.description}`).join("\n");
    }

    const names = await store.list();
    if (names.length === 0) return "No memories stored yet.";
    return `Memories (${names.length}):\n${names.map((n) => `  - ${n}`).join("\n")}`;
  },
};

const costCommand: Command = {
  name: "cost",
  aliases: ["usage", "tokens"],
  description: "Show current session token usage and cost",
  usage: "/cost",
  execute: (_args, ctx) => {
    const { totalTokens, totalCost } = ctx;
    return [
      `📊 Session Stats`,
      `  Input tokens:   ${totalTokens.input.toLocaleString()}`,
      `  Output tokens:  ${totalTokens.output.toLocaleString()}`,
      `  Total tokens:   ${(totalTokens.input + totalTokens.output).toLocaleString()}`,
      `  Estimated cost: $${totalCost.toFixed(4)}`,
      `  Messages:       ${ctx.messageCount}`,
      ``,
      `Provider: ${ctx.config.provider.type} / ${ctx.config.provider.model}`,
    ].join("\n");
  },
};

const modelCommand: Command = {
  name: "model",
  aliases: ["provider"],
  description: "Show or switch the active model",
  usage: "/model [model-name]",
  execute: (args, ctx) => {
    if (args[0]) {
      return `Model switch requested: ${args[0]}\n(Note: model changes take effect on next session restart)`;
    }
    return `Current model: ${ctx.config.provider.type} / ${ctx.config.provider.model}`;
  },
};

const toolsCommand: Command = {
  name: "tools",
  aliases: ["tool"],
  description: "List available tools",
  usage: "/tools",
  execute: (_args, _ctx) => {
    return [
      "Available tools:",
      "  read_file      — Read a file",
      "  write_file     — Write/create a file",
      "  edit_file      — Exact string replacement in a file",
      "  glob           — Find files by pattern",
      "  grep           — Search file contents with regex",
      "  bash           — Execute shell commands",
      "  web_search     — Search the web",
      "  web_fetch      — Fetch and read a web page",
      "  task_create    — Create a task for tracking",
      "  task_update    — Update task status",
      "  task_list      — List all tasks",
    ].join("\n");
  },
};

const sessionCommand: Command = {
  name: "session",
  aliases: ["sess"],
  description: "Show or manage the current session",
  usage: "/session [resume|new|list]",
  execute: (args, ctx) => {
    if (args[0] === "new") {
      return "New session will be created on next prompt.";
    }
    if (args[0] === "list") {
      return `Session dir: ${ctx.config.session.persistPath}`;
    }
    return [
      `Session ID: ${ctx.sessionId}`,
      `Messages:   ${ctx.messageCount}`,
      `Tokens:     ${(ctx.totalTokens.input + ctx.totalTokens.output).toLocaleString()}`,
      `Cost:       $${ctx.totalCost.toFixed(4)}`,
      `Auto-resume: ${ctx.config.session.autoResume ? "on" : "off"}`,
    ].join("\n");
  },
};
