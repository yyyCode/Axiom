import fs from "node:fs/promises";
import path from "node:path";
import { type Message } from "../types/index.js";

// ─── Persistent Session Store ──────────────────────────────────────

/** A persisted session record */
export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  agentType: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  metadata: {
    turnCount: number;
    totalTokens: { input: number; output: number };
    costUsd: number;
    stopReason?: string;
  };
}

/**
 * File-based session store for multi-tenant persistence.
 * Sessions survive server restarts and can be resumed.
 */
export class SessionStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  private tenantPath(tenantId: string): string {
    return path.join(this.basePath, tenantId);
  }

  private filePath(tenantId: string, sessionId: string): string {
    return path.join(this.tenantPath(tenantId), `${sessionId}.json`);
  }

  async save(record: SessionRecord): Promise<void> {
    const dir = this.tenantPath(record.tenantId);
    await fs.mkdir(dir, { recursive: true });

    record.updatedAt = new Date().toISOString();
    await fs.writeFile(
      this.filePath(record.tenantId, record.sessionId),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
  }

  async load(
    tenantId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    try {
      const content = await fs.readFile(
        this.filePath(tenantId, sessionId),
        "utf-8",
      );
      return JSON.parse(content) as SessionRecord;
    } catch {
      return null;
    }
  }

  async list(tenantId: string): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];
    try {
      const dir = this.tenantPath(tenantId);
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await fs.readFile(path.join(dir, file), "utf-8");
        records.push(JSON.parse(content) as SessionRecord);
      }
    } catch { /* no sessions */ }
    return records.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(tenantId, sessionId));
    } catch { /* not found */ }
  }

  async count(tenantId: string): Promise<number> {
    try {
      const files = await fs.readdir(this.tenantPath(tenantId));
      return files.filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }
}
