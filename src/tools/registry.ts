import { z, type ZodObject, type ZodRawShape } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolInputSchema,
  ToolResult,
  ToolRiskLevel,
  JsonSchema,
} from "../types/index.js";

// ─── Schema Conversion ────────────────────────────────────────────

/** Convert a Zod schema to a simplified JSON Schema for LLM tool_use */
export function zodToJsonSchema(schema: ZodObject<ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: JsonSchema["properties"] = {};
  const required: string[] = [];

  for (const [key, ztype] of Object.entries(shape)) {
    const typeInfo = getZodTypeInfo(ztype);
    properties[key] = {
      type: typeInfo.type,
      description: typeInfo.description,
    };
    if (typeInfo.enum) properties[key]!.enum = typeInfo.enum;
    if (typeInfo.items) properties[key]!.items = typeInfo.items;

    // Fields without .optional() are required
    if (!ztype.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function getZodTypeInfo(
  ztype: z.ZodType,
): { type: string; description?: string; enum?: string[]; items?: { type: string } } {
  const def = (ztype as { _def?: z.ZodTypeDef })._def as {
    typeName?: string;
    description?: string;
    values?: unknown[];
    type?: z.ZodType;
  } | undefined;

  if (!def) return { type: "string" };

  switch (def.typeName) {
    case "ZodString":
      return { type: "string", description: (ztype as { description?: string }).description };
    case "ZodNumber":
      return { type: "number", description: (ztype as { description?: string }).description };
    case "ZodBoolean":
      return { type: "boolean", description: (ztype as { description?: string }).description };
    case "ZodEnum":
      return {
        type: "string",
        enum: def.values as string[],
        description: (ztype as { description?: string }).description,
      };
    case "ZodArray": {
      const itemType = def.type ? getZodTypeInfo(def.type) : { type: "string" };
      return {
        type: "array",
        items: { type: itemType.type },
        description: (ztype as { description?: string }).description,
      };
    }
    case "ZodOptional":
      return def.type ? getZodTypeInfo(def.type) : { type: "string" };
    default:
      return { type: "string" };
  }
}

// ─── Tool Definition Builder ──────────────────────────────────────

export interface ToolBuilderOpts {
  name: string;
  description: string;
  isMutating?: boolean;
  riskLevel?: ToolRiskLevel;
  permission?: ToolDefinition["permission"];
}

/**
 * Create a tool definition with full type safety.
 *
 * @example
 * ```ts
 * const readTool = defineTool({
 *   name: "read_file",
 *   description: "Read a file from the local filesystem.",
 * }, { path: z.string() }, async (input, ctx) => ({
 *   content: await ctx.readFile(input.path),
 * }));
 * ```
 */
export function defineTool<
  TShape extends ZodRawShape,
>(
  opts: ToolBuilderOpts,
  schemaShape: TShape,
  execute: (input: z.infer<ZodObject<TShape>>, context: ToolExecutionContext) => Promise<ToolResult>,
): ToolDefinition {
  const schema = z.object(schemaShape);
  const jsonSchema = zodToJsonSchema(schema);

  return {
    name: opts.name,
    description: opts.description,
    schema,
    jsonSchema,
    execute: execute as ToolDefinition["execute"],
    isMutating: opts.isMutating ?? false,
    riskLevel: opts.riskLevel ?? "safe",
    permission: opts.permission,
  };
}

// ─── Tool Registry ────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool definition */
  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Register multiple tools at once */
  registerAll(tools: ToolDefinition[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** Unregister a tool */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Get a tool by name */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** List all registered tool names */
  listNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Get all tool definitions (for sending to LLM) */
  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Get read-only tools */
  getReadOnly(): ToolDefinition[] {
    return this.getAll().filter((t) => !t.isMutating);
  }

  /** Get mutating tools */
  getMutating(): ToolDefinition[] {
    return this.getAll().filter((t) => t.isMutating);
  }

  /** Execute a tool by name with validated input */
  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Error: Unknown tool "${name}". Available: ${this.listNames().join(", ")}`,
        isError: true,
      };
    }

    // Validate input
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `Error: Invalid input for tool "${name}". ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        isError: true,
      };
    }

    // Read-only check
    if (context.readOnly && tool.isMutating) {
      return {
        content: `Error: Tool "${name}" requires write access but session is read-only.`,
        isError: true,
      };
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (err) {
      return {
        content: `Error executing "${name}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  /** Check if a tool name exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}

// ─── Global Registry ──────────────────────────────────────────────

/** Singleton registry for the application */
export const globalRegistry = new ToolRegistry();
