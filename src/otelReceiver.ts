import * as http from "http";

/** Parsed OTel trace request with token counts. */
export interface OTelRequest {
  requestId: string;
  traceId: string;
  conversationId: string;
  timestamp: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  ttftMs: number | null;
}

/** Aggregated live stats across all captured OTel data. */
export interface LiveStats {
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
  traceCached: number;
  metricCached: number;
  lastSeen: string;
  byModel: Map<string, ModelStats>;
}

export interface ModelStats {
  model: string;
  requests: number;
  prompt: number;
  completion: number;
  traceCached: number;
  metricCached: number;
  cached: number;
}

type StatsListener = (stats: LiveStats) => void;

function utcNow(): string {
  return new Date().toISOString();
}

function nsToIso(ns: string): string {
  try {
    const ms = parseInt(ns, 10) / 1_000_000;
    return new Date(ms).toISOString();
  } catch {
    return utcNow();
  }
}

function getAttr(attributes: any[], key: string): any {
  if (!Array.isArray(attributes)) { return undefined; }
  for (const item of attributes) {
    if (item?.key !== key) { continue; }
    const v = item?.value;
    if (!v || typeof v !== "object") { return v; }
    for (const k of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
      if (k in v) { return v[k]; }
    }
  }
  return undefined;
}

function isToolSpan(span: any): boolean {
  const attrs = span?.attributes ?? [];
  return ["tool.name", "gen_ai.tool.name", "tool.type"].some(k => getAttr(attrs, k) !== undefined);
}

function parseTraceGroups(payload: any): OTelRequest[] {
  const grouped = new Map<string, any[]>();

  for (const rs of payload?.resourceSpans ?? []) {
    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        const tid = span?.traceId;
        if (!tid) { continue; }
        if (!grouped.has(tid)) { grouped.set(tid, []); }
        grouped.get(tid)!.push(span);
      }
    }
  }

  const results: OTelRequest[] = [];

  for (const [traceId, spans] of grouped) {
    // Pick primary span (non-tool, with most token info)
    const candidates = spans.filter(s => !isToolSpan(s));
    const pool = candidates.length > 0 ? candidates : spans;
    const primary = pool.reduce((best, s) => {
      const a = s.attributes ?? [];
      const hasTokens = (getAttr(a, "gen_ai.usage.prompt_tokens") ?? getAttr(a, "gen_ai.usage.input_tokens")) !== undefined;
      const hasModel = (getAttr(a, "gen_ai.request.model") ?? getAttr(a, "gen_ai.response.model")) !== undefined;
      const score = (hasTokens ? 2 : 0) + (hasModel ? 1 : 0);
      const bestA = best.attributes ?? [];
      const bestHasTokens = (getAttr(bestA, "gen_ai.usage.prompt_tokens") ?? getAttr(bestA, "gen_ai.usage.input_tokens")) !== undefined;
      const bestHasModel = (getAttr(bestA, "gen_ai.request.model") ?? getAttr(bestA, "gen_ai.response.model")) !== undefined;
      const bestScore = (bestHasTokens ? 2 : 0) + (bestHasModel ? 1 : 0);
      return score >= bestScore ? s : best;
    });

    if (!primary) { continue; }

    const attrs = primary.attributes ?? [];
    const model = getAttr(attrs, "gen_ai.response.model")
      ?? getAttr(attrs, "gen_ai.request.model")
      ?? getAttr(attrs, "llm.response.model")
      ?? getAttr(attrs, "llm.request.model")
      ?? "unknown";

    const promptTokens = Number(
      getAttr(attrs, "gen_ai.usage.prompt_tokens")
      ?? getAttr(attrs, "llm.usage.prompt_tokens")
      ?? getAttr(attrs, "gen_ai.usage.input_tokens")
      ?? 0
    );

    const completionTokens = Number(
      getAttr(attrs, "gen_ai.usage.completion_tokens")
      ?? getAttr(attrs, "llm.usage.completion_tokens")
      ?? getAttr(attrs, "gen_ai.usage.output_tokens")
      ?? 0
    );

    let cachedTokens: number | undefined = getAttr(attrs, "gen_ai.usage.cache_read.input_tokens");
    let ttft: number | undefined = getAttr(attrs, "copilot_chat.time_to_first_token");

    // Check child panel spans for cached/ttft
    if (cachedTokens === undefined || ttft === undefined) {
      for (const span of spans) {
        if (span === primary) { continue; }
        const ca = span.attributes ?? [];
        const agent = getAttr(ca, "gen_ai.agent.name") ?? "";
        if (!String(agent).startsWith("panel/")) { continue; }
        if (cachedTokens === undefined) {
          cachedTokens = getAttr(ca, "gen_ai.usage.cache_read.input_tokens");
        }
        if (ttft === undefined) {
          ttft = getAttr(ca, "copilot_chat.time_to_first_token");
        }
        if (cachedTokens !== undefined && ttft !== undefined) { break; }
      }
    }

    if (!promptTokens && !completionTokens && cachedTokens === undefined && ttft === undefined) {
      continue;
    }

    results.push({
      requestId: primary.spanId ?? traceId,
      traceId,
      conversationId: getAttr(attrs, "gen_ai.conversation.id") ?? "",
      timestamp: nsToIso(primary.startTimeUnixNano ?? "0"),
      modelName: model,
      promptTokens,
      completionTokens,
      cachedTokens: Number(cachedTokens ?? 0),
      ttftMs: ttft !== undefined ? Number(ttft) : null,
    });
  }

  return results;
}

/**
 * In-memory OTel store and HTTP receiver for Copilot telemetry.
 * Runs a lightweight HTTP server on localhost that accepts OTLP JSON.
 */
export class OTelReceiver {
  private requests: OTelRequest[] = [];
  private metricState = new Map<string, number>();
  private metricDeltas = new Map<string, number>(); // model -> cumulative cached delta
  private server: http.Server | null = null;
  private listeners: StatsListener[] = [];
  private _port = 0;

  get port(): number { return this._port; }

  onStats(listener: StatsListener): void {
    this.listeners.push(listener);
  }

  getStats(): LiveStats {
    const byModel = new Map<string, ModelStats>();

    for (const req of this.requests) {
      const key = req.modelName;
      if (!byModel.has(key)) {
        byModel.set(key, { model: key, requests: 0, prompt: 0, completion: 0, traceCached: 0, metricCached: 0, cached: 0 });
      }
      const m = byModel.get(key)!;
      m.requests++;
      m.prompt += req.promptTokens;
      m.completion += req.completionTokens;
      m.traceCached += req.cachedTokens;
    }

    // Add metric cache deltas
    for (const [model, delta] of this.metricDeltas) {
      if (!byModel.has(model)) {
        byModel.set(model, { model, requests: 0, prompt: 0, completion: 0, traceCached: 0, metricCached: 0, cached: 0 });
      }
      byModel.get(model)!.metricCached = delta;
    }

    // Compute effective cached
    for (const m of byModel.values()) {
      m.cached = m.metricCached || m.traceCached;
    }

    const prompt = this.requests.reduce((s, r) => s + r.promptTokens, 0);
    const completion = this.requests.reduce((s, r) => s + r.completionTokens, 0);
    const traceCached = this.requests.reduce((s, r) => s + r.cachedTokens, 0);
    const metricCached = Array.from(this.metricDeltas.values()).reduce((s, v) => s + v, 0);

    return {
      requests: this.requests.length,
      prompt,
      completion,
      cached: metricCached || traceCached,
      traceCached,
      metricCached,
      lastSeen: this.requests.length > 0 ? this.requests[this.requests.length - 1].timestamp : "",
      byModel,
    };
  }

  private processMetrics(payload: any): number {
    let inserted = 0;

    for (const rm of payload?.resourceMetrics ?? []) {
      for (const sm of rm?.scopeMetrics ?? []) {
        for (const metric of sm?.metrics ?? []) {
          if (metric?.name !== "gen_ai.client.token.usage") { continue; }

          const points = metric?.histogram?.dataPoints ?? metric?.sum?.dataPoints ?? [];
          for (const point of points) {
            const attrs = point?.attributes ?? [];
            const tokenType = String(getAttr(attrs, "gen_ai.token.type") ?? "");
            const model = getAttr(attrs, "gen_ai.response.model")
              ?? getAttr(attrs, "gen_ai.request.model")
              ?? "unknown";

            if (!tokenType.toLowerCase().includes("cache")) { continue; }

            const cumSum = point?.sum ?? point?.asDouble ?? point?.asInt;
            if (cumSum === undefined || cumSum === null) { continue; }

            const key = `gen_ai.client.token.usage:${model}:${tokenType}`;
            const current = Number(cumSum);
            const last = this.metricState.get(key) ?? 0;
            const delta = current - last;

            if (delta > 0) {
              this.metricState.set(key, current);
              const prev = this.metricDeltas.get(model) ?? 0;
              this.metricDeltas.set(model, prev + delta);
              inserted++;
            } else if (current < last) {
              this.metricState.set(key, current);
            }
          }
        }
      }
    }

    return inserted;
  }

  private readChunkedBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  private notify(): void {
    const stats = this.getStats();
    for (const fn of this.listeners) {
      try { fn(stats); } catch { /* ignore */ }
    }
  }

  async start(port = 14318): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/healthz") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }

        try {
          const body = await this.readChunkedBody(req);
          let payload: any = {};

          if (body.length > 0) {
            try {
              payload = JSON.parse(body.toString("utf-8"));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid JSON" }));
              return;
            }
          }

          if (req.url === "/v1/traces") {
            const parsed = parseTraceGroups(payload);
            // Deduplicate by requestId
            const existing = new Set(this.requests.map(r => r.requestId));
            const newReqs = parsed.filter(r => !existing.has(r.requestId));
            this.requests.push(...newReqs);
            this.notify();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, inserted: newReqs.length }));
            return;
          }

          if (req.url === "/v1/metrics") {
            const inserted = this.processMetrics(payload);
            if (inserted > 0) { this.notify(); }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, inserted }));
            return;
          }

          if (req.url === "/v1/logs") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });

      // Try candidate ports
      const tryPort = (p: number, attempts: number) => {
        this.server!.once("error", (err: any) => {
          if (err.code === "EADDRINUSE" && attempts > 0) {
            tryPort(p + 1, attempts - 1);
          } else {
            reject(err);
          }
        });
        this.server!.listen(p, "127.0.0.1", () => {
          this._port = p;
          resolve(p);
        });
      };

      tryPort(port, 5);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
