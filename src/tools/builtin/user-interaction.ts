import { z } from "zod";
import { defineTool } from "../registry.js";

// ─── Ask User Question ────────────────────────────────────────────

/** Callback to ask the user a question and get an answer */
export type AskUserCallback = (
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiSelect: boolean;
  }[],
) => Promise<Record<string, string>>;

let askUserCallback: AskUserCallback | null = null;

export function setAskUserCallback(cb: AskUserCallback): void {
  askUserCallback = cb;
}

export const askUserQuestionTool = defineTool(
  {
    name: "ask_user_question",
    description:
      "Ask the user one or more multiple-choice questions when blocked on a decision. Use only when genuinely blocked — prefer sensible defaults.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    questions: z.array(z.object({
      question: z.string().describe("The complete question to ask the user"),
      header: z.string().describe("Very short label (max 12 chars)"),
      options: z.array(z.object({
        label: z.string().describe("The display text for this option"),
        description: z.string().describe("Explanation of what this option means"),
      })).min(2).max(4),
      multiSelect: z.boolean().default(false),
    })).min(1).max(4),
  },
  async (input) => {
    if (!askUserCallback) {
      return {
        content: "User interaction not available in this context.",
        isError: true,
      };
    }

    try {
      const answers = await askUserCallback(
        input.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options,
          multiSelect: q.multiSelect,
        })),
      );

      const response = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join("\n\n");

      return {
        content: `User responses:\n${response}`,
        data: { answers },
      };
    } catch (err) {
      return {
        content: `Failed to get user response: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);
