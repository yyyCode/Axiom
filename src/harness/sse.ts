import { type ServerResponse } from "node:http";
import { type AgentEvent } from "../types/index.js";

// ─── SSE Stream ────────────────────────────────────────────────────

/**
 * Lightweight Server-Sent Events manager.
 *
 * Wraps a Node HTTP response and provides type-safe event emission.
 * Clients connect to `GET /api/agent/stream/:runId` and receive:
 *  - event: text       — LLM text deltas as they arrive
 *  - event: tool       — tool use and results
 *  - event: lifecycle  — turn_start, turn_end, compaction
 *  - event: done       — final result with usage stats
 *  - event: error      — error messages
 */
export class SSEStream {
  private res: ServerResponse;
  private runId: string;
  private closed = false;

  constructor(res: ServerResponse, runId: string) {
    this.res = res;
    this.runId = runId;

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx buffering off
    });

    // Send initial connection event
    this.send("connected", { runId });

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      if (this.closed) {
        clearInterval(heartbeat);
        return;
      }
      this.sendRaw(": heartbeat");
    }, 15000);

    res.on("close", () => {
      this.closed = true;
      clearInterval(heartbeat);
    });
  }

  /** Convert an AgentEvent to SSE format and send */
  forward(event: AgentEvent): void {
    if (this.closed) return;

    switch (event.type) {
      case "text_delta":
        this.send("text", { text: event.text });
        break;

      case "tool_use":
        this.send("tool", {
          action: "start",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;

      case "tool_result":
        this.send("tool", {
          action: "result",
          id: event.id,
          name: event.name,
          output: event.result,
        });
        break;

      case "tool_error":
        this.send("tool", {
          action: "error",
          id: event.id,
          name: event.name,
          error: event.error,
        });
        break;

      case "turn_start":
        this.send("lifecycle", { phase: "turn_start", turn: event.turn });
        break;

      case "turn_end":
        this.send("lifecycle", { phase: "turn_end", turn: event.turn });
        break;

      case "compaction":
        this.send("lifecycle", {
          phase: "compaction",
          fromTokens: event.fromTokens,
          toTokens: event.toTokens,
        });
        break;

      case "subagent_start":
        this.send("lifecycle", {
          phase: "subagent_start",
          id: event.id,
          description: event.description,
        });
        break;

      case "subagent_done":
        this.send("lifecycle", {
          phase: "subagent_done",
          id: event.id,
          result: event.result,
        });
        break;

      case "done":
        this.send("done", { reason: event.reason });
        this.close();
        break;

      case "error":
        this.send("error", { message: event.message });
        break;
    }
  }

  /** Send a named SSE event */
  send(event: string, data: unknown): void {
    this.sendRaw(
      `event: ${event}\n` +
        `data: ${JSON.stringify({ data, runId: this.runId, timestamp: new Date().toISOString() })}\n\n`,
    );
  }

  private sendRaw(raw: string): void {
    if (!this.closed) {
      this.res.write(raw);
    }
  }

  /** Close the SSE connection */
  close(): void {
    if (!this.closed) {
      this.sendRaw("data: [DONE]\n\n");
      this.res.end();
      this.closed = true;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ─── Connected Clients Registry ────────────────────────────────────

/** Track all open SSE connections by runId */
export class SSERegistry {
  private streams = new Map<string, SSEStream>();

  register(runId: string, stream: SSEStream): void {
    this.streams.set(runId, stream);
  }

  get(runId: string): SSEStream | undefined {
    return this.streams.get(runId);
  }

  remove(runId: string): void {
    this.streams.delete(runId);
  }

  /** Broadcast to all clients (for system announcements) */
  broadcast(event: string, data: unknown): void {
    for (const [runId, stream] of this.streams) {
      if (!stream.isClosed) {
        stream.send(event, data);
      } else {
        this.streams.delete(runId);
      }
    }
  }
}
