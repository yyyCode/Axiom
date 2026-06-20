import { z } from "zod";
import { defineTool } from "../registry.js";

// ─── In-memory Task Store ─────────────────────────────────────────

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
  metadata?: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
}

const taskStore = new Map<string, Task>();
let nextTaskId = 1;

function generateId(): string {
  return String(nextTaskId++);
}

// ─── Task Create ──────────────────────────────────────────────────

export const taskCreateTool = defineTool(
  {
    name: "task_create",
    description:
      "Create a structured task for tracking progress. Use this when you need to organize complex multi-step tasks.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    subject: z.string().describe("A brief, actionable title for the task"),
    description: z.string().describe("What needs to be done"),
    activeForm: z.string().optional().describe(
      "Present continuous form shown when the task is in progress",
    ),
    metadata: z.record(z.unknown()).optional().describe(
      "Arbitrary metadata to attach to the task",
    ),
  },
  async (input) => {
    const id = generateId();
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      status: "pending",
      activeForm: input.activeForm,
      metadata: input.metadata,
      blocks: [],
      blockedBy: [],
    };
    taskStore.set(id, task);

    return {
      content: `Task [${id}] created: ${input.subject}`,
      data: { task },
    };
  },
);

// ─── Task Update ──────────────────────────────────────────────────

export const taskUpdateTool = defineTool(
  {
    name: "task_update",
    description:
      "Update a task's status, description, or dependencies. Status workflow: pending → in_progress → completed. Use 'deleted' to remove.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    taskId: z.string().describe("The ID of the task to update"),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
    subject: z.string().optional().describe("New subject for the task"),
    description: z.string().optional().describe("New description for the task"),
    activeForm: z.string().optional(),
    addBlocks: z.array(z.string()).optional().describe(
      "Task IDs that this task blocks",
    ),
    addBlockedBy: z.array(z.string()).optional().describe(
      "Task IDs that block this task",
    ),
  },
  async (input) => {
    const task = taskStore.get(input.taskId);
    if (!task) {
      return {
        content: `Task [${input.taskId}] not found.`,
        isError: true,
      };
    }

    if (input.status) task.status = input.status;
    if (input.subject) task.subject = input.subject;
    if (input.description) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;
    if (input.addBlocks) task.blocks.push(...input.addBlocks);
    if (input.addBlockedBy) task.blockedBy.push(...input.addBlockedBy);

    if (input.status === "deleted") {
      taskStore.delete(input.taskId);
    }

    return {
      content: `Task [${input.taskId}] updated: ${task.subject} -> ${task.status}`,
      data: { task },
    };
  },
);

// ─── Task List ────────────────────────────────────────────────────

export const taskListTool = defineTool(
  {
    name: "task_list",
    description: "List all tasks in the task list with their status.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {},
  async () => {
    const tasks = [...taskStore.values()];

    if (tasks.length === 0) {
      return { content: "No tasks." };
    }

    const lines = tasks.map((t) => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○";
      const blocked = t.blockedBy.length > 0
        ? ` [blocked by: ${t.blockedBy.join(", ")}]`
        : "";
      return `[${t.id}] ${icon} ${t.subject} (${t.status})${blocked}`;
    });

    return {
      content: `Tasks:\n${lines.join("\n")}`,
      data: { tasks },
    };
  },
);

export const taskTools = [taskCreateTool, taskUpdateTool, taskListTool];
