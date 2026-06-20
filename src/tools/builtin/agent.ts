import { z } from "zod";
import { defineTool } from "../registry.js";
import type { SubAgentSpec } from "../../types/index.js";

/** Callback type: called when a subagent should be launched */
export type SubAgentLauncher = (spec: SubAgentSpec) => Promise<string>;

let subAgentLauncher: SubAgentLauncher | null = null;

/** Inject the subagent launcher (circular dependency avoidance) */
export function setSubAgentLauncher(launcher: SubAgentLauncher): void {
  subAgentLauncher = launcher;
}

// ─── Sub Agent ────────────────────────────────────────────────────

export const subAgentTool = defineTool(
  {
    name: "agent",
    description:
      "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities. Use for parallel work, code exploration, planning, and more.",
    isMutating: false,
    riskLevel: "safe",
  },
  {
    description: z.string().describe("A short (3-5 word) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    subagent_type: z.string().optional().describe(
      "The type of specialized agent to use (e.g. 'explore', 'plan', 'general')",
    ),
    model: z.string().optional().describe("Optional model override for this agent"),
  },
  async (input, ctx) => {
    if (!subAgentLauncher) {
      return {
        content: "Subagent system not initialized.",
        isError: true,
      };
    }

    try {
      const spec: SubAgentSpec = {
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        isolation: "isolated",
      };

      ctx.log(`[agent] spawning subagent: ${spec.description}`);
      const result = await subAgentLauncher(spec);

      return {
        content: result,
        data: { subagentId: spec.id, description: spec.description },
      };
    } catch (err) {
      return {
        content: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);
