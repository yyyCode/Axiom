import { z } from "zod";
import { defineTool } from "../registry.js";
import fs from "node:fs/promises";
import path from "node:path";

// ─── Read File ────────────────────────────────────────────────────

export const readFileTool = defineTool(
  {
    name: "read_file",
    description:
      "Reads a file from the local filesystem. Supports reading partial content via offset and limit parameters.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().optional().describe("Line number to start reading from"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  },
  async (input, ctx) => {
    const filePath = path.resolve(ctx.cwd, input.file_path);
    try {
      const content = await ctx.readFile(
        filePath,
        input.offset,
        input.limit,
      );
      const lines = content.split("\n");
      const lineCount = lines.length;
      const displayed = content;
      return {
        content: displayed,
        data: { path: filePath, lineCount, bytes: Buffer.byteLength(content) },
      };
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

// ─── Write File ───────────────────────────────────────────────────

export const writeFileTool = defineTool(
  {
    name: "write_file",
    description:
      "Writes a file to the local filesystem. Overwrites existing files. Creates parent directories if needed.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    file_path: z.string().describe("The absolute path where the file should be written"),
    content: z.string().describe("The content to write to the file"),
  },
  async (input, ctx) => {
    const filePath = path.resolve(ctx.cwd, input.file_path);
    try {
      // Check if file exists to warn about overwrite
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch { /* doesn't exist */ }

      await ctx.writeFile(filePath, input.content);
      const lines = input.content.split("\n").length;
      const bytes = Buffer.byteLength(input.content);

      return {
        content: existed
          ? `File updated: ${filePath} (${lines} lines, ${bytes} bytes)`
          : `File created: ${filePath} (${lines} lines, ${bytes} bytes)`,
        data: { path: filePath, lines, bytes, existed },
      };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

// ─── Edit File ────────────────────────────────────────────────────

export const editFileTool = defineTool(
  {
    name: "edit_file",
    description:
      "Performs exact string replacement in a file. old_string must match exactly including whitespace and indentation. The first match is replaced.",
    isMutating: true,
    riskLevel: "safe",
  },
  {
    file_path: z.string().describe("The absolute path to the file to modify"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The text to replace it with"),
    replace_all: z.boolean().optional().describe("Replace all occurrences (default: false)"),
  },
  async (input, ctx) => {
    const filePath = path.resolve(ctx.cwd, input.file_path);
    try {
      const content = await ctx.readFile(filePath);
      const replaceAll = input.replace_all ?? false;

      if (!content.includes(input.old_string)) {
        return {
          content: `Error: old_string not found in file. The text must match exactly including whitespace.`,
          isError: true,
        };
      }

      const occurrences = content.split(input.old_string).length - 1;
      if (occurrences > 1 && !replaceAll) {
        return {
          content: `Error: old_string matches ${occurrences} times in the file. Use replace_all: true to replace all, or make old_string more specific to match only one occurrence.`,
          isError: true,
        };
      }

      const newContent = replaceAll
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string);

      await ctx.writeFile(filePath, newContent);

      return {
        content: `File edited: ${filePath}\nReplaced ${replaceAll ? occurrences : 1} occurrence(s).`,
        data: { path: filePath, occurrences: replaceAll ? occurrences : 1 },
      };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

// ─── All File Tools ───────────────────────────────────────────────

export const fileTools = [readFileTool, writeFileTool, editFileTool];
