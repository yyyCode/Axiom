import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";
import { randomUUID } from "node:crypto";
import { type AgentProfile } from "./types.js";
import { AgentPool } from "./agent-pool.js";
import { SSEStream, SSERegistry } from "./sse.js";
import { SessionStore, type SessionRecord } from "./session-store.js";
import { WorkspaceSandbox } from "./sandbox.js";

// ─── Config ────────────────────────────────────────────────────────

export interface HarnessConfig {
  port: number;
  host: string;
  /** API key verification function */
  auth?: (apiKey: string) => Promise<{ tenantId: string; name: string } | null>;
  /** Simplify auth for dev */
  devMode?: boolean;
  dataDir: string;
  /** Path to frontend static files (optional) */
  frontendDir?: string;
  /** CORS origins */
  allowOrigins?: string[];
}

// ─── HTTP Server ───────────────────────────────────────────────────

export class AgentServer {
  private config: HarnessConfig;
  private pool: AgentPool;
  private sseRegistry: SSERegistry;
  private sessionStore: SessionStore;
  private server!: http.Server;

  constructor(config: HarnessConfig) {
    this.config = config;
    this.pool = new AgentPool();
    this.sseRegistry = new SSERegistry();
    this.sessionStore = new SessionStore(`${config.dataDir}/sessions`);
  }

  /** Access the agent pool (for wiring up reflection etc.) */
  getPool(): AgentPool { return this.pool; }

  /** Register an agent profile */
  registerAgent(profile: AgentProfile): this {
    this.pool.registerProfile(profile);
    return this;
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    await this.sessionStore.init();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(
          `🚀 Axiom Agent Server on http://${this.config.host}:${this.config.port}`,
        );
        console.log(`   Agents: ${this.pool.getProfileTypes().join(", ")}`);
        console.log(`   SSE:     /api/agent/stream?runId=...`);
        console.log(`   API:     POST /api/agent/run`);
        resolve();
      });
    });
  }

  /** Stop the server gracefully */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // ─── Request Handler ──────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS
    this.setCORS(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      // Routes
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return this.handleFrontend(res, "/index.html");
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return this.handleHealth(res);
      }

      if (req.method === "GET" && url.pathname === "/api/agent/types") {
        return this.handleAgentTypes(res);
      }

      if (req.method === "GET" && url.pathname === "/api/agent/stream") {
        return this.handleStream(req, res, url);
      }

      if (req.method === "POST" && url.pathname === "/api/agent/run") {
        return this.handleRun(req, res);
      }

      if (req.method === "POST" && url.pathname === "/api/agent/cancel") {
        return this.handleCancel(req, res);
      }

      if (req.method === "GET" && url.pathname === "/api/agent/tasks") {
        return this.handleListTasks(req, res, url);
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return this.handleListSessions(req, res, url);
      }

      if (req.method === "DELETE" && url.pathname === "/api/sessions") {
        return this.handleDeleteSession(req, res, url);
      }

      if (req.method === "POST" && url.pathname === "/api/agent/compact") {
        return this.handleCompact(req, res);
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal error",
        }),
      );
    }
  }

  // ─── Route Handlers ───────────────────────────────────────────

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        agents: this.pool.getProfileTypes(),
        running: [...Array.from({ length: 0 })], // proxy for count
      }),
    );
  }

  private handleAgentTypes(res: http.ServerResponse): void {
    const types = this.pool.getProfileTypes().map((t) => {
      const p = this.pool.getProfile(t);
      return { type: t, displayName: p?.displayName, description: p?.description };
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: types }));
  }

  /** GET /api/agent/stream?runId=xxx — SSE endpoint */
  private handleStream(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    const runId = url.searchParams.get("runId");
    if (!runId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing runId parameter" }));
      return;
    }

    const stream = new SSEStream(res, runId);
    this.sseRegistry.register(runId, stream);

    // Check if there's a pending run to launch
    this.onSSEConnect(runId, stream);

    // Check if run already completed
    const task = this.pool.getTask(runId);
    if (task?.status === "completed") {
      stream.send("done", { reason: task.result?.stopReason, result: task.result });
      stream.close();
      return;
    }
    if (task?.status === "failed") {
      stream.send("error", { message: task.error });
      stream.close();
      return;
    }
  }

  /** POST /api/agent/run — Start an agent run */
  private async handleRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);

    // Auth
    const tenantId = await this.authenticate(req, body);
    if (!tenantId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse request
    const agentType = body.agentType as string;
    const prompt = body.prompt as string;
    if (!agentType || !prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing agentType or prompt" }));
      return;
    }

    // Create SSE stream URL
    const runId = randomUUID();

    // Create a placeholder SSE connection (client opens separately)
    // We'll buffer events until the client connects
    // For now, we respond immediately and the client connects to the SSE URL

    const sseUrl = `/api/agent/stream?runId=${runId}`;

    // Launch will happen asynchronously when client opens the SSE stream,
    // OR we can launch now and let the SSE connection pick up events.
    // Strategy: launch in a deferred way — wait for SSE connection, then launch.
    // But simpler: acknowledge, client opens SSE, we detect connection and launch.

    // Simpler approach: acknowledge with runId, then on SSE connect, check if there's
    // a pending run. Or launch immediately and let SSE connect to receive events.

    // Practical approach for this implementation:
    // 1. Respond immediately with runId + streamUrl
    // 2. Store the pending run
    // 3. When client connects to SSE, launch the agent

    // For now, store request and launch when SSE connects
    // Eagerly create a "queued" task so it appears in /api/agent/tasks immediately
    const sessionId = (body as Record<string,unknown>).sessionId as string | undefined;
    this.pool.registerPending(runId, tenantId, agentType, prompt, sessionId);

    const pendingKey = `pending_${runId}`;
    this.pendingRuns.set(pendingKey, {
      tenantId,
      agentType,
      prompt,
      sessionId: sessionId,
      model: (body.overrides as Record<string,unknown> | undefined)?.model as string | undefined,
      maxTurns: (body.overrides as Record<string,unknown> | undefined)?.maxTurns as number | undefined,
      readOnly: (body.overrides as Record<string,unknown> | undefined)?.readOnly as boolean | undefined,
    });

    // Auto-clean pending run after 60s if no SSE connection
    setTimeout(() => {
      if (this.pendingRuns.has(pendingKey)) {
        this.pendingRuns.delete(pendingKey);
        // Mark task as failed if SSE never connected
        const t = this.pool.getTask(runId);
        if (t && t.status === "queued") {
          t.status = "failed";
          t.error = "SSE connection timeout";
        }
      }
    }, 60000);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        runId,
        streamUrl: sseUrl,
        agentType,
      }),
    );
  }

  // Store pending runs before SSE connects
  private pendingRuns = new Map<
    string,
    {
      tenantId: string;
      agentType: string;
      prompt: string;
      sessionId?: string;
      model?: string;
      maxTurns?: number;
      readOnly?: boolean;
    }
  >();

  /** POST /api/agent/cancel — Cancel a running agent */
  private async handleCancel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const tenantId = await this.authenticate(req, body);
    if (!tenantId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const runId = body.runId as string;
    const cancelled = this.pool.cancel(runId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cancelled, runId }));
  }

  /** GET /api/agent/tasks?tenantId=xxx */
  private async handleListTasks(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _url: URL,
  ): Promise<void> {
    const tenantId = await this.authenticate(req, {});
    if (!tenantId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const tasks = this.pool.listTasks(tenantId);
    console.log(`[api] GET /api/agent/tasks tenant=${tenantId} count=${tasks.length}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks }));
  }

  /** GET /api/sessions?tenantId=xxx — List sessions */
  private async handleListSessions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _url: URL,
  ): Promise<void> {
    const tenantId = await this.authenticate(req, {});
    if (!tenantId) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessions = await this.sessionStore.list(tenantId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
  }

  /** POST /api/agent/compact — Manually trigger context compaction */
  private async handleCompact(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const tenantId = await this.authenticate(req, body);
    if (!tenantId) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const runId = body.runId as string;
    const task = this.pool.getTask(runId);
    if (!task) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Run not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      message: `Compaction requested for run ${runId}. Auto-compaction runs at 92% context automatically.`,
      hint: "Auto-compaction is triggered before each turn when context exceeds the threshold. No manual action needed.",
    }));
  }

  /** DELETE /api/sessions?sessionId=xxx */
  private async handleDeleteSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const tenantId = await this.authenticate(req, {});
    if (!tenantId) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    await this.sessionStore.delete(tenantId, sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  /** Serve frontend static files */
  private async handleFrontend(
    res: http.ServerResponse,
    filePath: string,
  ): Promise<void> {
    const frontendDir = this.config.frontendDir;
    if (!frontendDir) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f13;color:#e1e1e8;">
        <h1>⚡ Axiom Agent Server</h1>
        <p>Server is running. API available at <code>/api/agent/run</code>.</p>
        <p>Set <code>frontendDir</code> in config to serve a custom frontend.</p>
        <p style="color:#9090a8;font-size:13px;margin-top:20px;">Agents: ${this.pool.getProfileTypes().join(", ")}</p>
        </body></html>`);
      return;
    }

    try {
      const fullPath = path.join(frontendDir, filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      const ext = path.extname(filePath);

      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };

      res.writeHead(200, {
        "Content-Type": mimeTypes[ext] ?? "text/plain",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async authenticate(
    req: http.IncomingMessage,
    _body: Record<string, unknown>,
  ): Promise<string | null> {
    if (this.config.devMode) return "dev-tenant";

    const authHeader = req.headers["authorization"];
    if (!authHeader) return null;

    const apiKey = authHeader.replace(/^Bearer\s+/i, "");
    if (!this.config.auth) return apiKey ? "default-tenant" : null;

    const result = await this.config.auth(apiKey);
    return result?.tenantId ?? null;
  }

  private async readBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          resolve(JSON.parse(body || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  }

  private setCORS(res: http.ServerResponse): void {
    const origins = this.config.allowOrigins ?? ["*"];
    res.setHeader("Access-Control-Allow-Origin", origins[0] ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }

  /** Called when SSE connects — launch pending agent */
  onSSEConnect(runId: string, stream: SSEStream): void {
    const pendingKey = `pending_${runId}`;
    const pending = this.pendingRuns.get(pendingKey);
    if (!pending) {
      console.log(`[server] SSE connected but no pending run: ${runId}`);
      return;
    }

    console.log(`[server] SSE client connected, launching agent: ${runId}`);
    this.pendingRuns.delete(pendingKey);

    // Launch the agent
    this.pool.launch(
      pending.tenantId,
      pending.agentType,
      pending.prompt,
      stream,
      {
        sessionId: pending.sessionId,
        model: pending.model,
        maxTurns: pending.maxTurns,
        readOnly: pending.readOnly,
      },
    );
  }
}
