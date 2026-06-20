import { z } from "zod";
import { defineTool } from "../registry.js";
import { execa } from "./shell.js";

// ─── Bash ─────────────────────────────────────────────────────────

export const bashTool = defineTool(
  {
    name: "bash",
    description:
      "Executes a bash command and returns its output. The shell state persists between calls within a session. Git operations and file modifications are supported.",
    isMutating: true,
    riskLevel: "dangerous",
    permission: async (input) => {
      // Block obviously dangerous patterns
      const cmd = input.command as string;
      const blocked = [
        /rm\s+-rf\s+\//,
        />\s*\/dev\/sda/,
        /mkfs\./,
        /dd\s+if=/,
        /fork\s*bomb/,
      ];
      for (const pattern of blocked) {
        if (pattern.test(cmd)) return false;
      }
      return true;
    },
  },
  {
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().describe(
      "Optional timeout in milliseconds (max 600000, default 120000)",
    ),
    description: z.string().optional().describe(
      "Clear, concise description of what this command does",
    ),
    run_in_background: z.boolean().optional().describe(
      "Set to true to run this command in the background",
    ),
  },
  async (input, ctx) => {
    const timeout = Math.min(input.timeout ?? 120000, 600000);

    try {
      ctx.log(`[bash] ${input.command}`);

      const result = await execa(input.command, {
        cwd: ctx.cwd,
        timeout,
        signal: ctx.signal,
      });

      const output = [
        result.stdout ? `STDOUT:\n${result.stdout}` : "",
        result.stderr ? `STDERR:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "(no output)";

      return {
        content: `Exit code: ${result.exitCode}\n${output}`,
        data: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    } catch (err) {
      return {
        content: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);
