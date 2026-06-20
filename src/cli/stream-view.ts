import { type AgentEvent } from "../types/index.js";

// ─── Terminal Stream Renderer ─────────────────────────────────────

const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const CYAN = `${CSI}36m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const RED = `${CSI}31m`;
const MAGENTA = `${CSI}35m`;
const GRAY = `${CSI}90m`;

/** ANSI escape sequence helpers (safe when piped to file) */
export function color(code: string, text: string, enabled = true): string {
  if (!enabled) return text;
  return `${code}${text}${RESET}`;
}

export function bold(text: string, enabled = true): string {
  return color(BOLD, text, enabled);
}

// ─── Stream View State ───────────────────────────────────────────

interface ToolEntry {
  id: string;
  name: string;
  input: string;
  startTime: number;
  status: "running" | "done" | "error";
  result?: string;
}

export class StreamView {
  private useColor: boolean;
  private showTokens: boolean;
  private currentTurn = 0;
  private tools: Map<string, ToolEntry> = new Map();
  private toolCount = 0;
  private textOutput = "";
  private lastLineHadNewline = true;

  constructor(opts: { color?: boolean; showTokens?: boolean }) {
    this.useColor = opts.color ?? true;
    this.showTokens = opts.showTokens ?? true;
  }

  /** Handle an AgentEvent and render it */
  handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.currentTurn = event.turn;
        if (this.currentTurn > 1) {
          process.stdout.write(`\n${DIM}[Turn ${event.turn}]${RESET}\n`);
        }
        break;

      case "text_delta":
        this.textOutput += event.text;
        // Stream text to stdout in real-time
        process.stdout.write(event.text);
        this.lastLineHadNewline = event.text.endsWith("\n");
        break;

      case "tool_use":
        this.toolCount++;
        this.tools.set(event.id, {
          id: event.id,
          name: event.name,
          input: JSON.stringify(event.input).slice(0, 100),
          startTime: Date.now(),
          status: "running",
        });
        // Show tool start on new line
        if (!this.lastLineHadNewline) process.stdout.write("\n");
        const icon = this.toolIcon(event.name);
        process.stdout.write(
          `  ${icon} ${color(CYAN, event.name, this.useColor)} ${DIM}${JSON.stringify(event.input).slice(0, 80)}${RESET}\n`,
        );
        this.lastLineHadNewline = true;
        break;

      case "tool_result": {
        const tool = this.tools.get(event.id);
        if (tool) {
          tool.status = "done";
          tool.result = event.result;
          const elapsed = Date.now() - tool.startTime;
          const preview = event.result.slice(0, 100).replace(/\n/g, " ");
          process.stdout.write(
            `  ${color(GREEN, "✓", this.useColor)} ${DIM}${preview}${preview.length >= 100 ? "..." : ""} (${elapsed}ms)${RESET}\n`,
          );
          this.lastLineHadNewline = true;
        }
        break;
      }

      case "tool_error": {
        const tool = this.tools.get(event.id);
        if (tool) {
          tool.status = "error";
          process.stdout.write(
            `  ${color(RED, "✗", this.useColor)} ${color(RED, event.error.slice(0, 100), this.useColor)}${RESET}\n`,
          );
          this.lastLineHadNewline = true;
        }
        break;
      }

      case "compaction":
        process.stdout.write(
          `\n${color(YELLOW, "📦 Compacted:", this.useColor)} ${event.fromTokens} → ${event.toTokens} tokens${RESET}\n`,
        );
        this.lastLineHadNewline = true;
        break;

      case "error":
        process.stderr.write(
          `\n${color(RED, "❌ " + event.message, this.useColor)}${RESET}\n`,
        );
        this.lastLineHadNewline = true;
        break;

      case "done":
        this.printDone(event.reason);
        break;

      case "subagent_start":
        process.stdout.write(
          `\n${color(MAGENTA, "🤖 Sub-agent:", this.useColor)} ${event.description}${RESET}\n`,
        );
        this.lastLineHadNewline = true;
        break;

      case "subagent_done":
        process.stdout.write(
          `${color(MAGENTA, "🤖 Done:", this.useColor)} ${event.result.slice(0, 80)}${RESET}\n`,
        );
        this.lastLineHadNewline = true;
        break;
    }
  }

  /** Print completion summary */
  printDone(reason: string): void {
    if (!this.lastLineHadNewline) process.stdout.write("\n");

    const doneColor = reason === "completed" ? GREEN : YELLOW;
    const icon = reason === "completed" ? "✅" : "⚠️";
    process.stdout.write(
      `\n${icon} ${color(doneColor, "Done", this.useColor)}${DIM} — ${reason} · ${this.currentTurn} turns · ${this.toolCount} tool calls${RESET}\n`,
    );
    this.lastLineHadNewline = true;
  }

  /** Reset state for a new run */
  reset(): void {
    this.currentTurn = 0;
    this.tools.clear();
    this.toolCount = 0;
    this.textOutput = "";
    this.lastLineHadNewline = true;
  }

  get totalToolCalls(): number { return this.toolCount; }
  get totalTurns(): number { return this.currentTurn; }
  get output(): string { return this.textOutput; }

  // ─── Private ─────────────────────────────────────────────────

  private toolIcon(name: string): string {
    const icons: Record<string, string> = {
      read_file: "📖",
      write_file: "✍️",
      edit_file: "✏️",
      glob: "🔍",
      grep: "🔎",
      bash: "⚡",
      web_search: "🌐",
      web_fetch: "📡",
      task_create: "📋",
      task_update: "📝",
      agent: "🤖",
    };
    return icons[name] || "🔧";
  }
}
