import readline from "node:readline";
import type { ToolRiskLevel } from "../types/index.js";

// ─── Interactive Permission Prompt ────────────────────────────────

export type PermissionMode = "default" | "auto" | "bypass";

export class PermissionPrompt {
  private mode: PermissionMode;
  private rl: readline.Interface;
  private autoDecisions = new Map<string, boolean>();

  constructor(mode: PermissionMode, rl: readline.Interface) {
    this.mode = mode;
    this.rl = rl;
  }

  /**
   * Ask user permission for a tool call.
   *
   * @returns true if allowed, false if denied
   */
  async ask(
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: ToolRiskLevel,
  ): Promise<boolean> {
    // Bypass mode: allow everything
    if (this.mode === "bypass") return true;

    // Auto mode: allow safe tools, prompt for dangerous
    if (this.mode === "auto" && riskLevel !== "dangerous") return true;

    // Check cache
    const cacheKey = `${toolName}:${riskLevel}`;
    if (this.autoDecisions.has(cacheKey)) {
      return this.autoDecisions.get(cacheKey)!;
    }

    // Display prompt
    const riskColor = riskLevel === "dangerous" ? "⚠️ " : "";
    console.log(`\n${riskColor}Tool: ${toolName}`);
    console.log(`  Risk: ${riskLevel}`);
    console.log(`  Input: ${JSON.stringify(input).slice(0, 150)}`);

    const answer = await this.question("  Allow? [y/N/a(always)/n(never)] ");

    const normalized = answer.toLowerCase().trim();

    if (normalized === "a" || normalized === "always") {
      this.autoDecisions.set(cacheKey, true);
      return true;
    }

    if (normalized.startsWith("n") && normalized.includes("never")) {
      this.autoDecisions.set(cacheKey, false);
      return false;
    }

    return normalized === "y" || normalized === "yes";
  }

  private question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }
}
