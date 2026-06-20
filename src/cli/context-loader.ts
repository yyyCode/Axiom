import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Context Loader ───────────────────────────────────────────────

export interface ProjectContext {
  cwd: string;
  instructions?: string;
  gitBranch?: string;
  gitStatus?: string;
  filesOfInterest: string[];
  platform: string;
  date: string;
}

/**
 * Load project context for System Prompt injection.
 * Equivalent to Claude Code's context assembly at startup.
 */
export function loadProjectContext(cwd: string, instructionsFile: string): ProjectContext {
  const ctx: ProjectContext = {
    cwd,
    filesOfInterest: [],
    platform: `${process.platform} ${process.arch}`,
    date: new Date().toISOString().split("T")[0]!,
  };

  // Load instructions file (AGENTS.md / CLAUDE.md)
  const instructionsPath = join(cwd, instructionsFile);
  if (existsSync(instructionsPath)) {
    try {
      ctx.instructions = readFileSync(instructionsPath, "utf-8");
    } catch { /* unreadable */ }
  }

  // Load git status
  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    if (branch) ctx.gitBranch = branch;
  } catch { /* not a git repo */ }

  if (ctx.gitBranch) {
    try {
      const status = execSync("git status --short", { cwd, encoding: "utf-8", timeout: 3000 });
      const lines = status.trim().split("\n").filter(Boolean);
      if (lines.length > 0 && lines.length <= 30) {
        ctx.gitStatus = lines.join("\n");
      } else if (lines.length > 30) {
        ctx.gitStatus = lines.slice(0, 30).join("\n") + `\n... and ${lines.length - 30} more changes`;
      }
    } catch { /* git status failed */ }
  }

  // Detect files of interest (package.json, etc.)
  for (const name of ["package.json", "Cargo.toml", "go.mod", "requirements.txt", "pyproject.toml"]) {
    if (existsSync(join(cwd, name))) {
      ctx.filesOfInterest.push(name);
    }
  }

  return ctx;
}

/**
 * Build the dynamic portion of the system prompt from project context.
 */
export function buildContextString(ctx: ProjectContext): string {
  const parts: string[] = [];

  parts.push(`<cwd>${ctx.cwd}</cwd>`);
  parts.push(`<platform>${ctx.platform}</platform>`);
  parts.push(`<date>${ctx.date}</date>`);

  if (ctx.gitBranch) {
    parts.push(`<git_branch>${ctx.gitBranch}</git_branch>`);
  }
  if (ctx.gitStatus) {
    parts.push(`<git_status>\n${ctx.gitStatus}\n</git_status>`);
  }

  if (ctx.instructions) {
    parts.push(`<project_instructions>\n${ctx.instructions}\n</project_instructions>`);
  }

  return parts.join("\n");
}
