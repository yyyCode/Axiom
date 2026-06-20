import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentConfig,
  type Message,
  type StopReason,
} from "../types/index.js";
import { type TokenUsage } from "../providers/base.js";

// ─── Session ──────────────────────────────────────────────────────

export interface Session {
  id: string;
  config: AgentConfig;
  messages: Message[];
  metadata: SessionMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMetadata {
  stopReason?: StopReason;
  turnCount: number;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  tags: string[];
  /** Custom metadata for application use */
  custom: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  metadata: SessionMetadata;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Session Manager ──────────────────────────────────────────────

/**
 * Session lifecycle manager.
 *
 * Features:
 *  - Create/resume/fork sessions
 *  - Persist sessions to disk for later resumption
 *  - Session metadata tracking
 *  - Auto-resume support
 */
export class SessionManager {
  private persistPath?: string;
  private activeSession?: Session;
  private sessions: Map<string, Session> = new Map();

  constructor(config: AgentConfig) {
    this.persistPath = config.session.persistPath;
  }

  /** Create a new session */
  create(config: AgentConfig): Session {
    const session: Session = {
      id: randomUUID(),
      config,
      messages: [],
      metadata: {
        turnCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        tags: [],
        custom: {},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.activeSession = session;
    this.sessions.set(session.id, session);

    return session;
  }

  /** Get the active session */
  getActive(): Session | undefined {
    return this.activeSession;
  }

  /** Resume a session by ID */
  resume(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.activeSession = session;
    }
    return session;
  }

  /** Fork a session (clone with new ID) */
  fork(sessionId: string): Session | undefined {
    const original = this.sessions.get(sessionId);
    if (!original) return undefined;

    const fork: Session = {
      ...original,
      id: randomUUID(),
      messages: [...original.messages],
      metadata: {
        ...original.metadata,
        custom: { ...original.metadata.custom, forkedFrom: sessionId },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.activeSession = fork;
    this.sessions.set(fork.id, fork);

    return fork;
  }

  /** Update session after a turn completes */
  updateSession(
    messages: Message[],
    stopReason: StopReason,
    usage: TokenUsage,
  ): void {
    const session = this.activeSession;
    if (!session) return;

    session.messages = messages;
    session.metadata.turnCount++;
    session.metadata.tokenUsage = {
      inputTokens: session.metadata.tokenUsage.inputTokens + usage.inputTokens,
      outputTokens: session.metadata.tokenUsage.outputTokens + usage.outputTokens,
    };
    session.metadata.stopReason = stopReason;
    session.metadata.estimatedCostUsd =
      (session.metadata.tokenUsage.inputTokens / 1_000_000) * 3 +
      (session.metadata.tokenUsage.outputTokens / 1_000_000) * 15;
    session.updatedAt = new Date().toISOString();
  }

  /** Persist the active session to disk */
  async persist(): Promise<void> {
    if (!this.persistPath || !this.activeSession) return;

    await fs.mkdir(this.persistPath, { recursive: true });
    const filePath = path.join(
      this.persistPath,
      `${this.activeSession.id}.json`,
    );
    await fs.writeFile(
      filePath,
      JSON.stringify(this.activeSession, null, 2),
      "utf-8",
    );
  }

  /** Load all sessions from the persist path */
  async loadAll(): Promise<Session[]> {
    if (!this.persistPath) return [];

    const sessions: Session[] = [];
    try {
      const files = await fs.readdir(this.persistPath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await fs.readFile(
          path.join(this.persistPath, file),
          "utf-8",
        );
        const session = JSON.parse(content) as Session;
        this.sessions.set(session.id, session);
        sessions.push(session);
      }
    } catch {
      // No sessions to load
    }

    return sessions;
  }

  /** List all sessions */
  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      metadata: s.metadata,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  /** Delete a session */
  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);

    if (this.activeSession?.id === sessionId) {
      this.activeSession = undefined;
    }

    if (this.persistPath) {
      try {
        await fs.unlink(path.join(this.persistPath, `${sessionId}.json`));
      } catch { /* file doesn't exist */ }
    }
  }
}
