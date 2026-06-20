import { type AgentConfig, type ToolRiskLevel } from "../types/index.js";
import { type ToolRegistry } from "../tools/registry.js";

// ─── Permission Levels ────────────────────────────────────────────

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassAll";

/**
 * Single chokepoint for all tool permission checks.
 *
 * Architecture inspired by Claude Code: every tool execution flows
 * through one function, making it trivial to add security policies,
 * audit logging, and rate limiting without modifying individual tools.
 */
export class PermissionChecker {
  private mode: PermissionMode;
  private allowedTools?: Set<string>;
  private deniedTools?: Set<string>;

  constructor(config: AgentConfig) {
    this.mode = "default"; // Can be overridden per session
  }

  /** Set the permission mode for this session */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Allow only specific tools (plan mode) */
  allowOnly(toolNames: string[]): void {
    this.allowedTools = new Set(toolNames);
  }

  /** Deny specific tools */
  deny(toolNames: string[]): void {
    this.deniedTools = new Set(toolNames);
  }

  /** Check if a tool can be used */
  async canUse(
    toolName: string,
    input: Record<string, unknown>,
    registry: ToolRegistry,
  ): Promise<boolean> {
    const tool = registry.get(toolName);
    if (!tool) return false;

    // Bypass mode
    if (this.mode === "bypassAll") return true;

    // Plan mode: only read-only tools
    if (this.mode === "plan" && tool.isMutating) return false;

    // Explicit allowlist
    if (this.allowedTools && !this.allowedTools.has(toolName)) return false;

    // Explicit denylist
    if (this.deniedTools?.has(toolName)) return false;

    // Risk-level check
    if (tool.riskLevel === "dangerous" && this.mode === "acceptEdits") {
      return false;
    }

    // Custom tool permission
    if (tool.permission) {
      return tool.permission(input, {
        cwd: process.cwd(),
        sessionId: "",
        readOnly: this.mode === "plan",
        readFile: async () => "",
        writeFile: async () => {},
        log: () => {},
      });
    }

    return true;
  }

  /** Get the effective risk level for UI display */
  getRiskLevel(toolName: string, registry: ToolRegistry): ToolRiskLevel {
    const tool = registry.get(toolName);
    return tool?.riskLevel ?? "safe";
  }
}
