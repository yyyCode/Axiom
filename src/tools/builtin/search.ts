import { z } from "zod";
import { defineTool } from "../registry.js";
import path from "node:path";
import { glob as globLib } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";

// ─── Glob ─────────────────────────────────────────────────────────

export const globTool = defineTool(
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Supports ** for recursive matching. Returns sorted file paths.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    pattern: z.string().describe("The glob pattern to match files against (e.g. '**/*.ts')"),
    path: z.string().optional().describe(
      "The directory to search in. Defaults to the current working directory.",
    ),
  },
  async (input, ctx) => {
    const searchPath = input.path
      ? path.resolve(ctx.cwd, input.path)
      : ctx.cwd;

    try {
      // Verify directory exists
      await access(searchPath);

      const fullPattern = path.join(searchPath, input.pattern).replace(/\\/g, "/");
      const results: string[] = [];

      const asyncGen = globLib(fullPattern, {
        // node:glob does not have a cwd option that works simply;
        // we construct the full pattern instead.
      });

      for await (const match of asyncGen) {
        const relative = path.relative(ctx.cwd, match.toString());
        results.push(relative);
      }

      // Sort by modification time would require additional stat calls;
      // just sort alphabetically for now
      results.sort();

      if (results.length === 0) {
        return { content: `No files matched pattern: ${input.pattern}` };
      }

      const display = results.length > 100
        ? results.slice(0, 100).join("\n") + `\n... and ${results.length - 100} more`
        : results.join("\n");

      return { content: display, data: { files: results, count: results.length } };
    } catch (err) {
      return {
        content: `Error in glob: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

// ─── Grep ─────────────────────────────────────────────────────────

export const grepTool = defineTool(
  {
    name: "grep",
    description:
      "Search file contents using a regular expression pattern. Uses ripgrep-like syntax. Returns matching file paths or lines.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    pattern: z.string().describe("The regular expression pattern to search for"),
    path: z.string().optional().describe(
      "File or directory to search in. Defaults to current working directory.",
    ),
    glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe(
      "Output mode. Default: files_with_matches",
    ),
    head_limit: z.number().optional().describe(
      "Limit output to first N results. Default: 250.",
    ),
    multiline: z.boolean().optional().describe(
      "Enable multiline mode where . matches newlines. Default: false.",
    ),
  },
  async (input, ctx) => {
    const searchPath = input.path
      ? path.resolve(ctx.cwd, input.path)
      : ctx.cwd;
    const outputMode = input.output_mode ?? "files_with_matches";
    const headLimit = input.head_limit ?? 250;

    try {
      const pattern = new RegExp(input.pattern, input.multiline ? "gs" : "g");
      const results = await searchFiles(
        searchPath,
        input.glob,
        pattern,
        outputMode === "content",
        headLimit,
      );

      if (results.length === 0) {
        return { content: `No matches found for pattern: ${input.pattern}` };
      }

      const display = results.join("\n");
      return {
        content: display,
        data: { matches: results, count: results.length, truncated: results.length >= headLimit },
      };
    } catch (err) {
      return {
        content: `Error in grep: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

async function searchFiles(
  dir: string,
  globFilter: string | undefined,
  pattern: RegExp,
  showContent: boolean,
  limit: number,
): Promise<string[]> {
  const results: string[] = [];

  // Use glob from the built-in glob to find matching files
  const globPattern = globFilter ? `**/${globFilter}` : "**/*";
  const files: string[] = [];

  try {
    const asyncGen = globLib(path.join(dir, globPattern).replace(/\\/g, "/"));
    for await (const f of asyncGen) {
      files.push(f.toString());
      if (files.length > 1000) break; // Safety limit
    }
  } catch { /* glob failed, try single file */ }

  // Ensure `dir` is used correctly when no glob match occurred or for single files
  if (files.length === 0) {
    try {
      await access(dir);
      files.push(dir);
    } catch { /* doesn't exist */ }
  }

  for (const file of files) {
    if (results.length >= limit) break;

    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(file));
      if (stat.isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const rl = createInterface({
        input: createReadStream(file, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      let lineNum = 0;
      for await (const line of rl) {
        if (results.length >= limit) break;
        lineNum++;
        pattern.lastIndex = 0; // Reset for each line
        if (pattern.test(line)) {
          const relative = path.relative(dir, file);
          if (showContent) {
            results.push(`${relative}:${lineNum}: ${line.trim()}`);
          } else {
            if (!results.includes(relative)) {
              results.push(relative);
            }
          }
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return results;
}

export const searchTools = [globTool, grepTool];
