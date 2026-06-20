import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ─── Workspace Sandbox ─────────────────────────────────────────────

/**
 * Per-session isolated workspace.
 *
 * Each agent run gets its own directory under workspaces/<tenantId>/<sessionId>/.
 * File operations are scoped to this directory, preventing cross-tenant leaks.
 */
export class WorkspaceSandbox {
  readonly root: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly workspacePath: string;

  constructor(basePath: string, tenantId: string, sessionId: string) {
    this.root = basePath;
    this.tenantId = tenantId;
    this.sessionId = sessionId;
    this.workspacePath = path.join(basePath, tenantId, sessionId);
  }

  /** Create the workspace directory and scaffold basic structure */
  async init(): Promise<void> {
    await fs.mkdir(this.workspacePath, { recursive: true });
    // Create subdirs based on common agent needs
    await fs.mkdir(path.join(this.workspacePath, "output"), { recursive: true });
    await fs.mkdir(path.join(this.workspacePath, "memory"), { recursive: true });
  }

  /** Resolve a user-provided path to within the sandbox */
  resolve(userPath: string): string {
    // Strip any leading slashes and resolve relative to workspace
    const normalized = userPath.replace(/^[\\/]+/, "");
    return path.join(this.workspacePath, normalized);
  }

  /** Read a file, scoped to the sandbox */
  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    const resolved = this.resolve(filePath);
    this.assertInSandbox(resolved);

    const content = await fs.readFile(resolved, "utf-8");
    const lines = content.split("\n");
    const start = offset ?? 0;
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  /** Write a file, scoped to the sandbox */
  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolve(filePath);
    this.assertInSandbox(resolved);

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  /** List all files in the workspace */
  async listFiles(): Promise<string[]> {
    const files: string[] = [];
    await this.walkDir(this.workspacePath, files);
    return files.map((f) => path.relative(this.workspacePath, f));
  }

  /** Clean up the workspace after session ends */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.workspacePath, { recursive: true, force: true });
    } catch { /* already cleaned */ }
  }

  // ─── Private ─────────────────────────────────────────────────

  private assertInSandbox(resolved: string): void {
    const normalized = resolved.replace(/\\/g, "/");
    const sandboxNormalized = this.workspacePath.replace(/\\/g, "/");
    if (!normalized.startsWith(sandboxNormalized)) {
      throw new Error(
        `Path traversal blocked: "${resolved}" is outside workspace`,
      );
    }
  }

  private async walkDir(dir: string, results: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(full, results);
      } else {
        results.push(full);
      }
    }
  }
}

// ─── Sandbox Manager ──────────────────────────────────────────────

export class SandboxManager {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  /** Create a new sandbox for a session */
  async create(tenantId: string, sessionId?: string): Promise<WorkspaceSandbox> {
    const sid = sessionId ?? randomUUID();
    const sandbox = new WorkspaceSandbox(this.basePath, tenantId, sid);
    await sandbox.init();
    return sandbox;
  }

  /** Clean up old sandboxes */
  async purgeOlderThan(maxAgeMs: number): Promise<number> {
    let count = 0;
    const now = Date.now();

    try {
      const tenants = await fs.readdir(this.basePath);
      for (const tenant of tenants) {
        const tenantPath = path.join(this.basePath, tenant);
        const stat = await fs.stat(tenantPath);
        if (!stat.isDirectory()) continue;

        const sessions = await fs.readdir(tenantPath);
        for (const session of sessions) {
          const sessionPath = path.join(tenantPath, session);
          const sStat = await fs.stat(sessionPath);
          if (now - sStat.mtimeMs > maxAgeMs) {
            await fs.rm(sessionPath, { recursive: true, force: true });
            count++;
          }
        }
      }
    } catch { /* ok */ }

    return count;
  }
}
