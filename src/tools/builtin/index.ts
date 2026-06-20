import { type ToolDefinition } from "../../types/index.js";
import { type BuiltinToolSet } from "../../types/index.js";
import { fileTools } from "./files.js";
import { searchTools } from "./search.js";
import { bashTool } from "./bash.js";
import { webTools } from "./web.js";
import { subAgentTool } from "./agent.js";
import { taskTools } from "./tasks.js";
import { askUserQuestionTool } from "./user-interaction.js";

// ─── Built-in Tool Map ────────────────────────────────────────────

/** Map of builtin tool set names to their tool definitions */
export const builtinToolMap: Record<BuiltinToolSet, ToolDefinition> = {
  read_file: fileTools[0]!,
  write_file: fileTools[1]!,
  edit_file: fileTools[2]!,
  glob: searchTools[0]!,
  grep: searchTools[1]!,
  bash: bashTool,
  web_search: webTools[0]!,
  web_fetch: webTools[1]!,
  sub_agent: subAgentTool,
  task_management: taskTools[0]!, // task_create (task_update/list also available)
  ask_user: askUserQuestionTool,
};

/** Get tools for the requested builtin sets + any custom tools */
export function resolveTools(
  builtin: BuiltinToolSet[],
  custom: ToolDefinition[] = [],
): ToolDefinition[] {
  const allBuiltins = [...new Set(builtin)];

  const tools: ToolDefinition[] = [];

  for (const name of allBuiltins) {
    const tool = builtinToolMap[name];
    if (tool) tools.push(tool);

    // task_management includes all three task tools
    if (name === "task_management") {
      tools.push(taskTools[1]!); // task_update
      tools.push(taskTools[2]!); // task_list
    }
  }

  tools.push(...custom);
  return tools;
}

export * from "./files.js";
export * from "./search.js";
export * from "./bash.js";
export * from "./web.js";
export * from "./agent.js";
export * from "./tasks.js";
export * from "./user-interaction.js";
