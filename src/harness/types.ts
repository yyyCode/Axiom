import { type AgentConfig, type AgentEvent } from "../types/index.js";

// ─── Harness Types ────────────────────────────────────────────────

/** Tenant/user identity for multi-tenancy */
export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  /** Tenant-specific config overrides */
  config?: Partial<AgentConfig>;
  /** Allowed agent types */
  allowedAgents: string[];
  /** Resource quotas */
  quota: TenantQuota;
}

export interface TenantQuota {
  maxConcurrentSessions: number;
  maxDailyTokens: number;
  maxSessions: number;
}

/** A registered agent profile the tenant can launch */
export interface AgentProfile {
  type: string; // "novel" | "video" | custom
  displayName: string;
  description: string;
  /** Config factory — creates AgentConfig for each run */
  configFactory: (tenantId: string) => AgentConfig;
  /** Tools factory — creates tools for each run */
  toolsFactory: (tenantId: string) => Promise<import("../types/index.js").ToolDefinition[]>;
}

/** HTTP request to start an agent run */
export interface AgentRunRequest {
  agentType: string;
  prompt: string;
  sessionId?: string; // resume existing, or omit to create new
  /** Inline attachments (files, context) */
  attachments?: Array<{
    name: string;
    content: string;
  }>;
  /** Override config values for this run */
  overrides?: Partial<AgentRunOverrides>;
}

export interface AgentRunOverrides {
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  readOnly?: boolean;
}

/** HTTP response — immediate acknowledgment */
export interface AgentRunResponse {
  ok: true;
  runId: string;
  sessionId: string;
  streamUrl: string; // SSE endpoint
}

/** Task in the execution queue */
export interface AgentTask {
  runId: string;
  tenantId: string;
  agentType: string;
  sessionId: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentRunResult;
  error?: string;
}

/** Final result from an agent run */
export interface AgentRunResult {
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  costUsd: number;
}

/** SSE event sent to the client */
export interface SSEMessage {
  event: string; // "text" | "tool" | "lifecycle" | "done" | "error"
  data: unknown;
  runId: string;
  timestamp: string;
}
