/**
 * Axiom Harness — Web Service Layer
 *
 * Wraps the Axiom Agent Kernel as an HTTP service with:
 *  - REST API for agent lifecycle
 *  - SSE streaming for real-time output
 *  - Multi-tenant isolation
 *  - Session persistence
 *  - Workspace sandboxing
 *
 * @packageDocumentation
 */

export { AgentServer, type HarnessConfig } from "./server.js";
export { AgentPool } from "./agent-pool.js";
export { SSEStream, SSERegistry } from "./sse.js";
export { WorkspaceSandbox, SandboxManager } from "./sandbox.js";
export { SessionStore, type SessionRecord } from "./session-store.js";
export type {
  Tenant,
  AgentProfile,
  AgentRunRequest,
  AgentRunResponse,
  AgentTask,
  AgentRunResult,
  SSEMessage,
} from "./types.js";
