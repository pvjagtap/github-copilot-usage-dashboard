/**
 * scanner.ts — Scan VS Code chatSession JSONL files from workspaceStorage.
 * Extracts sessions, turns, tool calls, subagents, and prompt previews.
 * Fully async with concurrent file I/O and mtime caching.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { isObj, isArr, mapConcurrent } from "./util";

// ─── Data Types ───────────────────────────────────────────────

export interface Session {
  sessionId: string;
  workspaceHash: string;
  sourcePath: string;
  sourceCount: number;
  projectName: string;
  sessionTitle: string;
  promptCount: number;
  promptPreview: string;
  transcriptCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  modelName: string;
  modelFamily: string;
  /**
   * Vendor VS Code itself recorded for the dispatched model (`copilot`,
   * `customendpoint`, `ollama`, …). Unlike the vendor map derived from
   * `chatLanguageModels.json`, this is observed routing evidence, so it
   * resolves ids sold by BOTH Copilot and a BYOK key. "" when unknown.
   */
  modelVendor: string;
  /** BYOK provider display name from the model identifier, e.g. `Azure OAI`. */
  modelProvider: string;
  modelMultiplier: number;
  accountLabel: string;
  agentId: string;
  location: string;
  totalPromptTokens: number;
  totalOutputTokens: number;
  /** Actual total from debug-logs (sum of all LLM API calls across all turns). 0 if no debug-log. */
  debugTotalPrompt: number;
  /** Actual total output from debug-logs. 0 if no debug-log. */
  debugTotalOutput: number;
  /** Actual total AI credits from API responses (nano-AIU / 1e9). 0 if not available. */
  debugTotalAicCredits: number;
  turnCount: number;
  toolCallRounds: number;
  toolCallResults: number;
  subagentCalls: number;
  sourcePaths: string[];
  transcriptPaths: string[];
  debugLogPath: string;
  /**
   * Epoch-ms activity markers from debug-logs, used ONLY by the prompt-cache
   * TTL tracker (src/ttlTracker.ts). Deliberately excluded from every token
   * and credit summation path — adding them must never move an AIC number.
   * 0 when the session has no debug-log.
   */
  lastTurnStartMs: number;
  lastTurnEndMs: number;
  /** Epoch ms of the newest `llm_request` across main + child logs. */
  lastRequestMs: number;
  /** `attrs.model` of that newest `llm_request` — drives TTL provider mapping. */
  lastRequestModel: string;
}

export interface Turn {
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  modelFamily: string;
  /**
   * Vendor VS Code recorded on THIS turn's `modelId` — the per-request
   * routing fact that decides billability for a colliding id. Only applies
   * to requests whose model equals `modelFamily`; auxiliary calls in the same
   * turn (title generation, subagents) run on their own route.
   */
  modelVendor?: string;
  /**
   * Provider display name from the same identifier (`Azure Foundry Anthropic`).
   * Empty for Copilot and for providers that record no name.
   */
  modelProvider?: string;
  promptTokens: number;
  outputTokens: number;
  /** Actual cumulative input tokens from debug-logs (sum of all LLM API calls in this turn). */
  debugPromptTokens: number;
  /** Actual cumulative output tokens from debug-logs. */
  debugOutputTokens: number;
  /** Cumulative cached (cache-read) tokens from debug-logs. 0 if not reported. */
  debugCachedTokens: number;
  /** Number of LLM API calls seen in debug-logs for this turn. */
  debugLlmCalls: number;
  /** Actual AI credits for this turn from API responses (nano-AIU / 1e9). 0 if not available. */
  debugAicCredits: number;
  /**
   * VS Code's own `copilotCredits` for the user request behind this turn (every
   * LLM call of the request, subagents included) and the request's start time.
   * `debugAicCredits` is overwritten by the debug-log figure, so these are kept
   * to detect credits whose `llm_request` lines the debug log no longer holds.
   */
  chatCredits?: number;
  chatStartMs?: number;
  /**
   * AI credits for the LAST single llm_request in this turn (not the sum).
   * Used by the dashboard's `AIC (last req)` widget so it shows one API
   * call's bill, not the entire turn's. 0 if not available.
   */
  debugLastRequestAic: number;
  /** ISO timestamp of the LAST single llm_request in this turn. */
  debugLastRequestTs: string;
  /**
   * Per-model breakdown of all llm_requests in this turn (parent + merged
   * child sessions). Keyed by the `attrs.model` reported on each `llm_request`
   * entry in main.jsonl / child *.jsonl. Surfaces small/auxiliary models
   * (e.g. `gpt-4o-mini-2024-07-18` used for title generation, `claude-haiku-4.5`
   * used by subagents) that would otherwise be hidden under the parent turn's
   * single `modelFamily`. Undefined when no llm_requests carried a model attr.
   */
  debugByModel?: Record<string, DebugModelTotals>;
  /** Individual debug-log llm_request records used to dedupe live OTel requests. */
  debugRequests?: DebugRequest[];
  toolCallRounds: number;
  toolCallResults: number;
  workspaceName: string;
}

/** Per-model token + AIC totals from debug-log llm_request entries. */
export interface DebugModelTotals {
  prompt: number;
  output: number;
  cached: number;
  calls: number;
  /** Sum of copilotUsageNanoAiu for this model (divide by 1e9 for credits). */
  nanoAiu: number;
}

/** Single API-billed llm_request captured from debug logs. */
export interface DebugRequest {
  timestamp: string;
  model: string;
  prompt: number;
  output: number;
  cached: number;
  nanoAiu: number;
  /**
   * `attrs.debugName` — the call site. Copilot-routed requests name the
   * feature that issued them (`panel/editAgent`, `summarizeConversationHistory`,
   * `title`, …); requests dispatched through VS Code's public
   * `LanguageModelChat` API report `copilotLanguageModelWrapper`, which is the
   * only per-request evidence that a BYOK provider served the call.
   */
  debugName?: string;
  /**
   * Token mix used only to apportion `nanoAiu` across the Input / Output /
   * Cached columns when the request has no token counts of its own (a request
   * recovered from the chatSession). Never summed into token totals.
   */
  splitTokens?: { prompt: number; output: number; cached: number };
}

export interface ToolCall {
  sessionId: string;
  turnIndex: number;
  callIndex: number;
  toolName: string;
  isSubagent: boolean;
}

export interface Subagent {
  sessionId: string;
  turnIndex: number;
  callIndex: number;
  agentName: string;
  description: string;
}

export interface ScanResult {
  sessions: Session[];
  turns: Turn[];
  toolCalls: ToolCall[];
  subagents: Subagent[];
  stats: ScanStats;
}

export interface ScanStats {
  sourceFiles: number;
  canonicalSessions: number;
  mirroredSessions: number;
  mirrorCopiesPruned: number;
  turnsStored: number;
  toolCallsStored: number;
  promptPreviews: number;
  transcriptsFound: number;
  debugLogSessions: number;
}

// ─── Safe JSON Accessors ──────────────────────────────────────

/** Safely get a string from an unknown value at a key path */
function str(obj: unknown, ...keys: string[]): string {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return "";
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : "";
}

/** Safely get a number from an unknown value at a key path */
function num(obj: unknown, ...keys: string[]): number {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return 0;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : 0;
}

/** Safely get a value from an unknown object (returns unknown) */
function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// isObj / isArr now imported from ./util

/**
 * Strip file:// scheme and decode percent-encoding from a VS Code workspace URI.
 * On Windows, removes the leading slash before the drive letter (e.g. "/C:/" → "C:/").
 * Returns the string unchanged if it doesn't start with file://.
 */
function normalizeFileUri(uri: string): string {
  let p = uri;
  if (p.startsWith("file:///")) {
    p = p.slice(8);
  } else if (p.startsWith("file://")) {
    p = p.slice(7);
  }
  p = decodeURIComponent(p);
  if (/^\/[A-Z]:/i.test(p)) {
    p = p.slice(1);
  }
  return p;
}

/**
 * Pull (agentName, description) from a runSubagent tool call's `arguments`
 * field. Accepts either a JSON string or an already-parsed object.
 *
 * `agentName` is optional on the tool — omitting it runs the caller's own
 * agent, which Copilot names `default` in the child debug log
 * (`runSubagent-default-<callId>.jsonl`). Reporting that as "unknown" implied
 * lost data for what is in fact the most common case. "unknown" is now
 * reserved for arguments that could not be parsed at all.
 */
function extractSubagentArgs(rawArgs: unknown): { agentName: string; description: string } {
  let agentName = "unknown";
  let description = "";
  try {
    const args: unknown = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (isObj(args)) {
      agentName =
        typeof args.agentName === "string" && args.agentName.trim()
          ? args.agentName
          : "default";
      description = typeof args.description === "string" ? args.description : "";
    }
  } catch {
    /* ignore */
  }
  return { agentName, description };
}

/**
 * Common emit path for both the kind=0 (v.requests[]) and kind=1 (...result)
 * parse branches. Given a turn-result `meta` blob, pushes one Turn plus all
 * its tool-call / subagent rows.
 *
 * Caller is responsible for resolving turnIndex, timestamp and workspaceName
 * because each branch derives them from different fields.
 */
/**
 * Split a VS Code chat model identifier into its parts.
 *
 * Shapes seen on disk (verified across every local chatSession):
 *   `copilot/claude-opus-5`
 *   `customendpoint/Azure Foundry Anthropic/claude-opus-5`
 *   `claude-opus-5`                       (legacy, no vendor recorded)
 *
 * The vendor is the FIRST segment and the model id the LAST; anything between
 * them is the provider's display name.
 */
export function splitModelIdentifier(raw: string): {
  model: string;
  vendor: string;
  provider: string;
} {
  const parts = (raw || "").split("/").filter(p => p.length > 0);
  if (parts.length === 0) {
    return { model: "", vendor: "", provider: "" };
  }
  if (parts.length === 1) {
    return { model: parts[0], vendor: "", provider: "" };
  }
  return {
    model: parts[parts.length - 1],
    vendor: parts[0].toLowerCase(),
    provider: parts.slice(1, -1).join("/"),
  };
}

/**
 * Human-readable name for who served a request.
 *
 * `vendor` is VS Code's provider *mechanism*, so for a Custom Endpoint it is
 * the literal string `customendpoint` — true but meaningless to a reader. The
 * identifier's middle segment holds the name the user actually typed
 * ("Azure Foundry Anthropic"), so prefer it and fall back to the vendor only
 * when no name was recorded.
 */
export function providerLabel(vendor: string, provider: string): string {
  const name = (provider || "").trim();
  if (name) {
    return name;
  }
  return (vendor || "").trim();
}

function emitTurnAndToolCalls(
  meta: Record<string, unknown>,
  ctx: {
    sessionId: string;
    turnIndex: number;
    modelFamily: string;
    modelVendor?: string;
    modelProvider?: string;
    timestamp: string;
    workspaceName: string;
  },
  out: { turns: Turn[]; toolCalls: ToolCall[]; subagents: Subagent[] }
): void {
  const { sessionId, turnIndex, modelFamily, modelVendor, modelProvider, timestamp, workspaceName } =
    ctx;

  out.turns.push({
    sessionId,
    turnIndex,
    timestamp,
    modelFamily,
    modelVendor,
    modelProvider,
    promptTokens: num(meta, "promptTokens"),
    outputTokens: num(meta, "outputTokens"),
    debugPromptTokens: 0,
    debugOutputTokens: 0,
    debugCachedTokens: 0,
    debugLlmCalls: 0,
    debugAicCredits: 0,
    debugLastRequestAic: 0,
    debugLastRequestTs: "",
    toolCallRounds: isArr(meta.toolCallRounds) ? meta.toolCallRounds.length : 0,
    toolCallResults: isArr(meta.toolCallResults) ? meta.toolCallResults.length : 0,
    workspaceName,
  });

  let callIndex = 0;
  if (isArr(meta.toolCallRounds)) {
    for (const round of meta.toolCallRounds) {
      if (!isObj(round)) {
        continue;
      }
      const roundCalls = round.toolCalls;
      if (!isArr(roundCalls)) {
        continue;
      }
      for (const tc of roundCalls) {
        if (!isObj(tc)) {
          continue;
        }
        const toolName = typeof tc.name === "string" ? tc.name : "unknown";
        const isSub = toolName === "runSubagent";
        out.toolCalls.push({ sessionId, turnIndex, callIndex, toolName, isSubagent: isSub });
        if (isSub) {
          const { agentName, description } = extractSubagentArgs(tc.arguments);
          out.subagents.push({ sessionId, turnIndex, callIndex, agentName, description });
        }
        callIndex++;
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function epochMsToIso(ms: number): string {
  if (!ms || ms <= 0) {
    return "";
  }
  return new Date(ms).toISOString();
}

function extractWorkspaceName(cacheKey: string | undefined, wsHash: string): string {
  if (!cacheKey) {
    return `workspace-${wsHash.slice(0, 8)}`;
  }
  try {
    const p = normalizeFileUri(cacheKey);
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join("/");
    }
    if (parts.length === 1) {
      return parts[0];
    }
  } catch {
    /* ignore */
  }
  return `workspace-${wsHash.slice(0, 8)}`;
}

function extractRequestText(requests: unknown[]): string {
  const texts: string[] = [];
  for (const req of requests) {
    if (!isObj(req)) {
      continue;
    }
    const msg = req.message;
    if (!isObj(msg)) {
      continue;
    }
    if (typeof msg.text === "string" && msg.text.trim()) {
      texts.push(msg.text.trim());
      continue;
    }
    if (isArr(msg.parts)) {
      for (const part of msg.parts) {
        if (typeof part === "string" && part.trim()) {
          texts.push(part.trim());
        } else if (isObj(part)) {
          const t = part.text ?? part.value ?? part.markdown ?? part.content;
          if (typeof t === "string" && t.trim()) {
            texts.push(t.trim());
          }
        }
      }
    }
  }
  const joined = texts.join(" | ").replace(/\s+/g, " ").trim();
  return joined.length > 180 ? joined.slice(0, 177) + "..." : joined;
}

// ─── Concurrency Utility ──────────────────────────────────────

// mapConcurrent now imported from ./util

// ─── JSONL Parser ─────────────────────────────────────────────

interface SessionBundle {
  session: Partial<Session>;
  turns: Turn[];
  toolCalls: ToolCall[];
  subagents: Subagent[];
}

function parseSessionContent(
  content: string,
  filePath: string,
  wsHash: string,
  projectName: string,
  fileStem: string
): SessionBundle | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) {
    return null;
  }

  let sessionId = "";
  let sessionTitle = "";
  let modelName = "unknown";
  let modelFamily = "unknown";
  let modelVendor = "";
  let modelProvider = "";
  let modelMultiplier = 1;
  let accountLabel = "";
  let firstTimestamp = "";
  let location = "";
  let agentId = "";
  let promptCount = 0;
  let promptPreview = "";

  // Current VS Code builds write no kind=0 header — the session id lives in the
  // filename and the requests array is materialised purely from kind=1 (set at
  // path) and kind=2 (append to array) ops. Replay them so the new shape can be
  // read; `sawKind0` keeps legacy files on the original code path below.
  let sawKind0 = false;
  const replayRequests: unknown[] = [];

  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const subagents: Subagent[] = [];

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry)) {
      continue;
    }

    const kind = entry.kind;
    const k = entry.k;
    const v = entry.v;

    // Replay capture for the current format. MUST run before the legacy
    // branches below — several of them `continue`, which would skip these ops
    // (notably `requests/N/result`, the only carrier of toolCallRounds).
    if (isArr(k) && k[0] === "requests") {
      if (kind === 2 && k.length === 1 && isArr(v)) {
        replayRequests.push(...v);
      } else if (kind === 1 && k.length === 3) {
        const idx = typeof k[1] === "number" ? k[1] : parseInt(String(k[1]), 10);
        if (Number.isInteger(idx) && idx >= 0) {
          const existing = replayRequests[idx];
          const target: Record<string, unknown> = isObj(existing) ? existing : {};
          target[String(k[2])] = v;
          replayRequests[idx] = target;
        }
      }
    }

    // kind=0: session metadata
    if (kind === 0 && isObj(v)) {
      sawKind0 = true;
      sessionId = typeof v.sessionId === "string" ? v.sessionId : "";
      if (typeof v.creationDate === "number") {
        firstTimestamp = epochMsToIso(v.creationDate);
      }
      if (typeof v.customTitle === "string") {
        sessionTitle = v.customTitle;
      }
      location = typeof v.initialLocation === "string" ? v.initialLocation : "";

      const sel = get(v, "inputState", "selectedModel");
      if (isObj(sel)) {
        const ident =
          typeof sel.identifier === "string" ? splitModelIdentifier(sel.identifier) : null;
        const meta = sel.metadata;
        if (isObj(meta)) {
          modelName =
            typeof meta.name === "string"
              ? meta.name
              : typeof sel.identifier === "string"
                ? sel.identifier
                : "unknown";
          modelFamily = typeof meta.family === "string" ? meta.family : "unknown";
          modelMultiplier = typeof meta.multiplierNumeric === "number" ? meta.multiplierNumeric : 0;
          accountLabel = str(meta, "auth", "accountLabel");
          // `metadata.vendor` is the same value the identifier encodes; prefer
          // it because it survives provider names that contain a slash.
          modelVendor =
            typeof meta.vendor === "string" ? meta.vendor.toLowerCase() : (ident?.vendor ?? "");
        } else {
          modelName = typeof sel.identifier === "string" ? sel.identifier : "unknown";
          modelVendor = ident?.vendor ?? "";
        }
        modelProvider = ident?.provider ?? "";
      }

      // New format: kind=0 v.requests[] contains embedded turn results
      const vRequests = v.requests;
      if (isArr(vRequests)) {
        for (let ri = 0; ri < vRequests.length; ri++) {
          const req = vRequests[ri];
          if (!isObj(req)) {
            continue;
          }
          const meta = get(req, "result", "metadata");
          if (isObj(meta)) {
            const metaTs = num(meta, "requestTimestamp");
            const reqTs = num(req as Record<string, unknown>, "timestamp");
            const timestamp = metaTs
              ? epochMsToIso(metaTs)
              : reqTs
                ? epochMsToIso(reqTs)
                : firstTimestamp;
            const wName = extractWorkspaceName(
              typeof meta.cacheKey === "string" ? meta.cacheKey : undefined,
              wsHash
            );
            if (typeof meta.agentId === "string") {
              agentId = meta.agentId;
            }
            const reqAgent = get(req, "agent", "id");
            if (typeof reqAgent === "string") {
              agentId = reqAgent;
            }

            emitTurnAndToolCalls(
              meta,
              {
                sessionId,
                turnIndex: ri,
                modelFamily,
                modelVendor: modelVendor || undefined,
                modelProvider: modelProvider || undefined,
                timestamp,
                workspaceName: wName,
              },
              { turns, toolCalls, subagents }
            );
          } else {
            // No result metadata yet — still count as a turn if there's a timestamp
            const reqTs = num(req as Record<string, unknown>, "timestamp");
            const ts = reqTs ? epochMsToIso(reqTs) : firstTimestamp;
            const reqAgent = get(req, "agent", "id");
            if (typeof reqAgent === "string") {
              agentId = reqAgent;
            }
            const hasResponse = "response" in (req as Record<string, unknown>);
            if (ts || hasResponse) {
              turns.push({
                sessionId,
                turnIndex: ri,
                timestamp: ts,
                modelFamily,
                modelVendor: modelVendor || undefined,
                modelProvider: modelProvider || undefined,
                promptTokens: 0,
                outputTokens: 0,
                debugPromptTokens: 0,
                debugOutputTokens: 0,
                debugCachedTokens: 0,
                debugLlmCalls: 0,
                debugAicCredits: 0,
                debugLastRequestAic: 0,
                debugLastRequestTs: "",
                toolCallRounds: 0,
                toolCallResults: 0,
                workspaceName: extractWorkspaceName(undefined, wsHash),
              });
            }
          }

          // Extract prompt preview from embedded request message
          if (ri === 0 && !promptPreview) {
            const msg = (req as Record<string, unknown>).message;
            if (isObj(msg)) {
              const text =
                typeof msg.text === "string"
                  ? msg.text.trim()
                  : isArr(msg.parts)
                    ? msg.parts
                        .filter((p): p is string => typeof p === "string")
                        .join(" ")
                        .trim()
                    : "";
              if (text) {
                promptPreview = text.length > 180 ? text.slice(0, 177) + "..." : text;
                promptCount = vRequests.length;
              }
            }
          }
        }
      }
      continue;
    }

    // kind=1, k=["customTitle"]: session title
    if (kind === 1 && isArr(k) && k[0] === "customTitle" && typeof v === "string") {
      sessionTitle = v;
      continue;
    }

    // kind=1, k=["requests", N, "result"]: turn result
    if (
      kind === 1 &&
      isArr(k) &&
      k.length === 3 &&
      k[0] === "requests" &&
      k[2] === "result" &&
      isObj(v)
    ) {
      const turnIndex = typeof k[1] === "number" ? k[1] : parseInt(String(k[1]), 10);
      const meta = v.metadata;
      if (!isObj(meta)) {
        continue;
      }

      const metaTs = num(meta, "requestTimestamp");
      const timestamp = metaTs ? epochMsToIso(metaTs) : firstTimestamp;
      const wName = extractWorkspaceName(
        typeof meta.cacheKey === "string" ? meta.cacheKey : undefined,
        wsHash
      );
      if (typeof meta.agentId === "string") {
        agentId = meta.agentId;
      }

      // A kind=0 header with an empty `requests[]` leaves the session-level
      // model unresolved, because only that array's `modelId` sets it. The
      // turns then arrive as kind=1 ops carrying their own model, so prefer
      // it — otherwise real Copilot turns render as "unknown" and get
      // classified non-billable.
      let turnFamily = modelFamily;
      let turnVendor = modelVendor;
      let turnProvider = modelProvider;
      const replayed = replayRequests[turnIndex];
      const rawTurnModel =
        isObj(replayed) && typeof replayed.modelId === "string"
          ? replayed.modelId
          : typeof meta.resolvedModel === "string"
            ? meta.resolvedModel
            : "";
      if (rawTurnModel) {
        const ident = splitModelIdentifier(rawTurnModel);
        turnFamily = ident.model;
        if (ident.vendor) {
          turnVendor = ident.vendor;
          turnProvider = ident.provider;
        }
        if (modelFamily === "unknown") {
          modelFamily = ident.model;
          if (modelName === "unknown") { modelName = ident.model; }
          if (ident.vendor) {
            modelVendor = ident.vendor;
            modelProvider = ident.provider;
          }
        }
      }

      emitTurnAndToolCalls(
        meta,
        {
          sessionId,
          turnIndex,
          modelFamily: turnFamily,
          modelVendor: turnVendor || undefined,
          modelProvider: turnProvider || undefined,
          timestamp,
          workspaceName: wName,
        },
        { turns, toolCalls, subagents }
      );
      continue;
    }

    // kind=2, k=["requests"]: latest prompt snapshot
    if (kind === 2 && isArr(k) && k[0] === "requests" && isArr(v)) {
      const text = extractRequestText(v);
      if (text) {
        promptCount = v.length;
        promptPreview = text;
      }
      continue;
    }
  }

  // A kind=0 session builds its turns from `requests/N/result` ops, which carry
  // no credits. The replayed request does (`copilotCredits`, `timestamp`), so
  // record VS Code's own per-request figure for truncation recovery. It is not
  // written to `debugAicCredits`: a turn the debug log never overlays would
  // then be counted on top of the log's own turns.
  if (sawKind0) {
    for (const t of turns) {
      const replayed = replayRequests[t.turnIndex];
      if (isObj(replayed)) {
        t.chatCredits = num(replayed, "copilotCredits");
        t.chatStartMs = num(replayed, "timestamp");
      }
    }
  }

  // ── Current format: no kind=0 header ──────────────────────
  // The legacy branches above only see `requests/N/result`, so they miss the
  // separate promptTokens / completionTokens / copilotCredits ops entirely.
  // Rebuild from the replayed array instead, which carries all of them.
  if (!sawKind0 && replayRequests.length > 0) {
    turns.length = 0;
    toolCalls.length = 0;
    subagents.length = 0;

    for (let ri = 0; ri < replayRequests.length; ri++) {
      const req = replayRequests[ri];
      if (!isObj(req)) {
        continue;
      }
      const meta = get(req, "result", "metadata");
      const metaObj = isObj(meta) ? meta : {};

      if (!sessionId && typeof metaObj.sessionId === "string") {
        sessionId = metaObj.sessionId;
      }
      if (typeof metaObj.agentId === "string") {
        agentId = metaObj.agentId;
      }
      const reqAgent = get(req, "agent", "id");
      if (typeof reqAgent === "string") {
        agentId = reqAgent;
      }

      // `copilot/claude-opus-5` → model `claude-opus-5`, vendor `copilot`.
      // The vendor prefix is the per-request routing fact; keep it rather
      // than discarding it with the rest of the prefix.
      let turnVendor = modelVendor;
      let turnProvider = modelProvider;
      const rawModel = typeof req.modelId === "string" ? req.modelId : "";
      if (rawModel) {
        const ident = splitModelIdentifier(rawModel);
        modelName = ident.model;
        modelFamily = ident.model;
        if (ident.vendor) {
          modelVendor = ident.vendor;
          modelProvider = ident.provider;
          turnProvider = ident.provider;
        }
        turnVendor = ident.vendor || modelVendor;
      }

      const completedAt = num(isObj(req.modelState) ? req.modelState : {}, "completedAt");
      const reqTs = num(req as Record<string, unknown>, "timestamp");
      const respTs = num(req as Record<string, unknown>, "responseTimestamp");
      const tsMs = completedAt || respTs || reqTs;
      const timestamp = tsMs ? epochMsToIso(tsMs) : firstTimestamp;
      if (!firstTimestamp && timestamp) {
        firstTimestamp = timestamp;
      }

      const prompt = num(req as Record<string, unknown>, "promptTokens");
      const completion = num(req as Record<string, unknown>, "completionTokens");
      // Copilot's own per-request credit figure. Debug logs overwrite this
      // later when they carry `copilotUsageNanoAiu` for the same turn.
      const credits = num(req as Record<string, unknown>, "copilotCredits");

      turns.push({
        sessionId,
        turnIndex: ri,
        timestamp,
        modelFamily,
        modelVendor: turnVendor || undefined,
        modelProvider: turnProvider || undefined,
        promptTokens: prompt,
        outputTokens: completion,
        debugPromptTokens: 0,
        debugOutputTokens: 0,
        debugCachedTokens: 0,
        debugLlmCalls: 0,
        debugAicCredits: credits,
        chatCredits: credits,
        chatStartMs: reqTs,
        debugLastRequestAic: 0,
        debugLastRequestTs: "",
        toolCallRounds: isArr(metaObj.toolCallRounds) ? metaObj.toolCallRounds.length : 0,
        toolCallResults: isArr(metaObj.toolCallResults) ? metaObj.toolCallResults.length : 0,
        workspaceName: extractWorkspaceName(
          typeof metaObj.cacheKey === "string" ? metaObj.cacheKey : undefined,
          wsHash
        ),
      });

      let callIndex = 0;
      if (isArr(metaObj.toolCallRounds)) {
        for (const round of metaObj.toolCallRounds) {
          if (!isObj(round) || !isArr(round.toolCalls)) {
            continue;
          }
          for (const tc of round.toolCalls) {
            if (!isObj(tc)) {
              continue;
            }
            const toolName = typeof tc.name === "string" ? tc.name : "unknown";
            const isSub = toolName === "runSubagent";
            toolCalls.push({ sessionId, turnIndex: ri, callIndex, toolName, isSubagent: isSub });
            if (isSub) {
              const { agentName, description } = extractSubagentArgs(tc.arguments);
              subagents.push({ sessionId, turnIndex: ri, callIndex, agentName, description });
            }
            callIndex++;
          }
        }
      }

      if (ri === 0 && !promptPreview) {
        const msg = (req as Record<string, unknown>).message;
        if (isObj(msg) && typeof msg.text === "string" && msg.text.trim()) {
          const text = msg.text.trim();
          promptPreview = text.length > 180 ? text.slice(0, 177) + "..." : text;
        }
      }
    }

    if (promptCount === 0) {
      promptCount = replayRequests.length;
    }
    // Session id now lives in the filename when no request carried metadata.
    if (!sessionId) {
      sessionId = fileStem;
    }
    for (const t of turns) {
      t.sessionId = sessionId;
    }
    for (const tc of toolCalls) {
      tc.sessionId = sessionId;
    }
    for (const sa of subagents) {
      sa.sessionId = sessionId;
    }
  }

  if (!sessionId) {
    return null;
  }

  // Calculate session totals from turns
  const totalPrompt = turns.reduce((s, t) => s + t.promptTokens, 0);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalToolRounds = turns.reduce((s, t) => s + t.toolCallRounds, 0);
  const totalToolResults = turns.reduce((s, t) => s + t.toolCallResults, 0);
  const subagentCallCount = subagents.length;
  const lastTimestamp =
    turns.length > 0
      ? turns.reduce((best, t) => (t.timestamp > best ? t.timestamp : best), "")
      : firstTimestamp;

  return {
    session: {
      sessionId,
      workspaceHash: wsHash,
      sourcePath: filePath,
      sourceCount: 1,
      projectName,
      sessionTitle,
      promptCount,
      promptPreview,
      transcriptCount: 0,
      firstTimestamp,
      lastTimestamp,
      modelName,
      modelFamily,
      modelVendor,
      modelProvider,
      modelMultiplier,
      accountLabel,
      agentId,
      location,
      totalPromptTokens: totalPrompt,
      totalOutputTokens: totalOutput,
      debugTotalPrompt: 0,
      debugTotalOutput: 0,
      debugTotalAicCredits: 0,
      turnCount: turns.length,
      toolCallRounds: totalToolRounds,
      toolCallResults: totalToolResults,
      subagentCalls: subagentCallCount,
      sourcePaths: [filePath],
      transcriptPaths: [],
      debugLogPath: "",
      lastTurnStartMs: 0,
      lastTurnEndMs: 0,
      lastRequestMs: 0,
      lastRequestModel: "",
    },
    turns,
    toolCalls,
    subagents,
  };
}

// ─── Canonical Selection (Deduplication) ──────────────────────

function canonicalScore(b: SessionBundle): number[] {
  const s = b.session;
  const totalTokens = (s.totalPromptTokens ?? 0) + (s.totalOutputTokens ?? 0);
  return [
    totalTokens,
    s.turnCount ?? 0,
    s.promptCount ?? 0,
    s.toolCallRounds ?? 0,
    s.subagentCalls ?? 0,
    s.transcriptCount ?? 0,
    s.sessionTitle ? 1 : 0,
    s.promptPreview ? 1 : 0,
  ];
}

function compareBundles(a: SessionBundle, b: SessionBundle): number {
  const sa = canonicalScore(a);
  const sb = canonicalScore(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return sb[i] - sa[i];
    }
  }
  return 0;
}

// ─── Async Discovery ──────────────────────────────────────────

interface FileEntry {
  path: string;
  wsHash: string;
  project: string;
}

async function resolveWorkspaceFile(wsUri: string, wsHash: string): Promise<string> {
  try {
    const p = normalizeFileUri(wsUri);

    const raw = await fsp.readFile(p, "utf-8");
    const wsContent: unknown = JSON.parse(raw);
    if (isObj(wsContent) && isArr(wsContent.folders) && wsContent.folders.length > 0) {
      const names = (wsContent.folders as unknown[])
        .map((f: unknown) => {
          const fp =
            typeof f === "string" ? f : isObj(f) && typeof f.path === "string" ? f.path : "";
          if (!fp) {
            return "";
          }
          const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
          return parts.length >= 2 ? parts.slice(-2).join("/") : parts[parts.length - 1] || "";
        })
        .filter(Boolean);
      if (names.length > 0) {
        return names.join(" + ");
      }
    }
  } catch {
    /* ignore */
  }
  return `multi-root-${wsHash.slice(0, 8)}`;
}

/**
 * Build the ordered list of candidate workspaceStorage roots to probe.
 * Order: explicit override → env override → portable → Linux → remote → macOS → Windows.
 * Insiders variants are included next to each stable entry.
 */
export function getWorkspaceStorageCandidates(override?: string): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  // Explicit user override (from VS Code setting)
  if (override && override.trim()) {
    candidates.push(override.trim());
  }

  // Env override — useful for tests, CI, and unusual installs.
  const envOverride = process.env.COPILOT_USAGE_WORKSPACE_STORAGE;
  if (envOverride && envOverride.trim()) {
    candidates.push(envOverride.trim());
  }

  // Portable VS Code (https://code.visualstudio.com/docs/editor/portable)
  const portable = process.env.VSCODE_PORTABLE;
  if (portable) {
    candidates.push(path.join(portable, "user-data", "User", "workspaceStorage"));
  }

  // Linux
  candidates.push(path.join(home, ".config", "Code", "User", "workspaceStorage"));
  candidates.push(path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"));

  // Remote (dev container / Remote-SSH / WSL — extension host runs server-side)
  candidates.push(path.join(home, ".vscode-server", "data", "User", "workspaceStorage"));
  candidates.push(path.join(home, ".vscode-server-insiders", "data", "User", "workspaceStorage"));

  // macOS
  candidates.push(
    path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage")
  );
  candidates.push(
    path.join(home, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage")
  );

  // Windows
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  candidates.push(path.join(appData, "Code", "User", "workspaceStorage"));
  candidates.push(path.join(appData, "Code - Insiders", "User", "workspaceStorage"));

  return candidates;
}

/** Default workspaceStorage path for the current platform, used when no candidate exists yet. */
function defaultWorkspaceStoragePath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      return path.join(appData, "Code", "User", "workspaceStorage");
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage");
    default:
      return path.join(home, ".config", "Code", "User", "workspaceStorage");
  }
}

/**
 * Resolve the active VS Code workspaceStorage directory.
 * Returns the first candidate that exists and is a directory, falling back
 * to a platform-appropriate default when none exist yet.
 */
export async function getWorkspaceStoragePath(override?: string): Promise<string> {
  for (const p of getWorkspaceStorageCandidates(override)) {
    if (await isDirectory(p)) {
      return p;
    }
  }
  return defaultWorkspaceStoragePath();
}

/** Check if a path is a directory (non-throwing). */
async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Get mtime of a file, or -1 if it doesn't exist / isn't a file. */
async function fileMtime(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st.mtimeMs : -1;
  } catch {
    return -1;
  }
}

/** Read directory entries (withFileTypes), returning empty on error. */
async function readDirSafe(p: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Read directory names (string[]), returning empty on error. */
async function readDirNames(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

/** wsHash / project labels for sessions that belong to no workspace folder. */
const EMPTY_WINDOW_HASH = "emptyWindowChatSessions";
const EMPTY_WINDOW_PROJECT = "(no folder)";

/** Sessions predating the JSONL delta log are a single `.json` object. */
function isSessionFileName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".json");
}

/**
 * workspaceHash → folder name, learned at activation from `context.storageUri`.
 * Current VS Code no longer writes `workspace.json` into the storage dir, so
 * without this every project renders as the `workspace-<hash8>` fallback.
 */
let _projectNameHints: Record<string, string> = {};

export function setProjectNameHints(hints: Record<string, string>): void {
  _projectNameHints = hints;
}

/**
 * Wrap a legacy `.json` session so the kind=0 branch of the JSONL parser can
 * consume it — the object is exactly the `v` payload that kind=0 carries.
 */
function legacyJsonToKind0(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? JSON.stringify({ kind: 0, v }) : "";
  } catch {
    return "";
  }
}

/**
 * List the immediate subdirectories of `wsRoot`, sorted by name.
 * Non-directory entries are filtered out; missing/inaccessible roots yield [].
 */
async function listWorkspaceDirsSorted(wsRoot: string): Promise<fs.Dirent[]> {
  const entries = await readDirSafe(wsRoot);
  // Dirent.isDirectory() is false for symlinks and Windows junctions, so keep
  // those too — callers stat the paths they build and drop non-directories.
  return entries
    .filter(e => e.isDirectory() || e.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Process a single workspace directory for session files. */
async function processWorkspaceDirForSessions(
  wsRoot: string,
  dirName: string
): Promise<FileEntry[]> {
  const wsDir = path.join(wsRoot, dirName);
  const chatDir = path.join(wsDir, "chatSessions");

  if (!(await isDirectory(chatDir))) {
    return [];
  }

  // Resolve project name from workspace.json
  let projectName = `workspace-${dirName.slice(0, 8)}`;
  const hint = _projectNameHints[dirName];
  if (hint) {
    projectName = hint;
  }
  const workspaceJsonPath = path.join(wsDir, "workspace.json");
  try {
    const raw = await fsp.readFile(workspaceJsonPath, "utf-8");
    const wsJson: unknown = JSON.parse(raw);
    if (isObj(wsJson)) {
      if (typeof wsJson.folder === "string") {
        projectName = extractWorkspaceName(wsJson.folder, dirName);
      } else if (typeof wsJson.workspace === "string") {
        projectName = await resolveWorkspaceFile(wsJson.workspace, dirName);
      }
    }
  } catch {
    /* ignore */
  }

  const names = await readDirNames(chatDir);
  const jsonlFiles = names.filter(isSessionFileName).sort();

  return jsonlFiles.map(f => ({
    path: path.join(chatDir, f),
    wsHash: dirName,
    project: projectName,
  }));
}

/** Discover all session JSONL files across workspaceStorage. */
async function discoverSessionFiles(wsRoot: string): Promise<FileEntry[]> {
  const dirs = await listWorkspaceDirsSorted(wsRoot);

  const results = await mapConcurrent(dirs, 16, async entry => {
    return processWorkspaceDirForSessions(wsRoot, entry.name);
  });

  return results.flat();
}

/**
 * Chats started in a window with no folder open are written to a flat global
 * store instead of `<wsRoot>/<hash>/chatSessions`, so they need their own
 * discovery pass or they never reach the dashboard.
 */
export function getEmptyWindowSessionsPath(wsRoot: string): string {
  return path.join(path.dirname(wsRoot), "globalStorage", "emptyWindowChatSessions");
}

/** realpath, or the input unchanged when it cannot be resolved. */
async function realpathSafe(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/**
 * The global store normally sits beside `wsRoot`. When the configured root
 * points at the *target* of a relocated/symlinked storage dir that sibling
 * does not exist, so fall back to the standard root that resolves to the same
 * place. Unrelated roots (test fixtures) match nothing and get no global store.
 */
async function resolveEmptyWindowDir(wsRoot: string): Promise<string> {
  const sibling = getEmptyWindowSessionsPath(wsRoot);
  if (await isDirectory(sibling)) {
    return sibling;
  }

  const target = await realpathSafe(wsRoot);
  for (const candidate of getWorkspaceStorageCandidates()) {
    if (candidate === wsRoot) {
      continue;
    }
    if ((await realpathSafe(candidate)) !== target) {
      continue;
    }
    const viaCandidate = getEmptyWindowSessionsPath(candidate);
    if (await isDirectory(viaCandidate)) {
      return viaCandidate;
    }
  }
  return "";
}

async function discoverEmptyWindowSessionFiles(wsRoot: string): Promise<FileEntry[]> {
  const dir = await resolveEmptyWindowDir(wsRoot);
  if (!dir) {
    return [];
  }

  const names = await readDirNames(dir);
  return names
    .filter(isSessionFileName)
    .sort()
    .map(f => ({
      path: path.join(dir, f),
      wsHash: EMPTY_WINDOW_HASH,
      project: EMPTY_WINDOW_PROJECT,
    }));
}

/** Discover all transcript JSONL files. */
async function discoverTranscriptFiles(wsRoot: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const dirs = await listWorkspaceDirsSorted(wsRoot);

  await mapConcurrent(dirs, 16, async entry => {
    const tDir = path.join(wsRoot, entry.name, "GitHub.copilot-chat", "transcripts");
    if (!(await isDirectory(tDir))) {
      return;
    }

    const names = await readDirNames(tDir);
    const files = names.filter(f => f.endsWith(".jsonl")).sort();

    for (const f of files) {
      const stem = path.basename(f, ".jsonl");
      const list = map.get(stem) ?? [];
      list.push(path.join(tDir, f));
      map.set(stem, list);
    }
  });

  return map;
}

// ─── Debug-Log Scanner ────────────────────────────────────────

interface DebugLogTurnTokens {
  turnIndex: number;
  promptTotal: number;
  outputTotal: number;
  /** Sum of cache-read tokens for all LLM calls in this turn (attrs.cachedTokens). */
  cachedTotal: number;
  llmCalls: number;
  /**
   * Epoch ms timestamp of last activity for this turn. Initialized from
   * turn_start, then bumped on every llm_request so the dashboard's
   * "most recent turn" picker reflects actual last activity instead of
   * when the turn began. Long-running turns with many llm_request calls
   * otherwise looked older than freshly-started short turns.
   */
  timestamp: number;
  /** Sum of copilotUsageNanoAiu for all LLM calls in this turn */
  nanoAiu: number;
  /**
   * nano-AIU of the LAST single llm_request in this turn. Distinct from
   * `nanoAiu` (which is the sum across the turn). Used so `AIC (last req)`
   * shows a single API call's bill, not a turn total.
   */
  lastRequestNanoAiu: number;
  /** Epoch ms timestamp of the last single llm_request in this turn. */
  lastRequestTs: number;
  /**
   * Per-model breakdown for this turn (parent + merged child sessions).
   * Keyed by `attrs.model` from each `llm_request`. Surfaces auxiliary
   * models (title gpt-4o-mini, subagent haiku, etc.) that the parent
   * turn's single `modelFamily` would otherwise hide.
   */
  byModel: Map<string, DebugModelTotals>;
  /** Individual llm_request records for request-level live OTel reconciliation. */
  requests: DebugRequest[];
}

/** Initialise an empty DebugModelTotals row. */
function emptyModelTotals(): DebugModelTotals {
  return { prompt: 0, output: 0, cached: 0, calls: 0, nanoAiu: 0 };
}

/** Initialise an empty per-turn debug-log accumulator with timestamp. */
function emptyDebugTurn(turnIndex: number, timestamp = 0): DebugLogTurnTokens {
  return {
    turnIndex,
    promptTotal: 0,
    outputTotal: 0,
    cachedTotal: 0,
    llmCalls: 0,
    timestamp,
    nanoAiu: 0,
    lastRequestNanoAiu: 0,
    lastRequestTs: 0,
    byModel: new Map<string, DebugModelTotals>(),
    requests: [],
  };
}

/** Merge `src` into `dst` (in-place). Used for parent-turn ← child-session aggregation. */
function mergeByModel(dst: Map<string, DebugModelTotals>, src: Map<string, DebugModelTotals>): void {
  for (const [model, s] of src) {
    const d = dst.get(model) ?? emptyModelTotals();
    d.prompt += s.prompt;
    d.output += s.output;
    d.cached += s.cached;
    d.calls += s.calls;
    d.nanoAiu += s.nanoAiu;
    dst.set(model, d);
  }
}

interface DebugLogData {
  sessionId: string;
  filePath: string;
  turns: DebugLogTurnTokens[];
  totalPrompt: number;
  totalOutput: number;
  totalLlmCalls: number;
  /** Total nano-AIU from all LLM calls (sum of copilotUsageNanoAiu) */
  totalNanoAiu: number;
  /** Individual llm_request records across this debug-log directory. */
  requests: DebugRequest[];
  /** TTL-only activity markers (epoch ms). Never feed token/credit sums. */
  lastTurnStartMs: number;
  lastTurnEndMs: number;
  lastRequestMs: number;
  lastRequestModel: string;
}

/**
 * Parse debug-log content to extract per-turn and total LLM token usage.
 * Also collects child_session_ref filenames for aggregation.
 */
interface ParsedDebugLog {
  sessionId: string;
  totalPrompt: number;
  totalOutput: number;
  totalLlmCalls: number;
  totalNanoAiu: number;
  turnMap: Map<number, DebugLogTurnTokens>;
  /** Maps child log filename → parent turnIndex that spawned it */
  childLogFiles: Map<string, number>;
  /**
   * Per-model breakdown summed across the entire file (every llm_request,
   * whether or not it was inside a turn). Used to recover the AIC of
   * `title-*.jsonl` and any other child file that emits llm_requests before
   * `turn_start` fires — those would otherwise be invisible in `turnMap`.
   */
  byModel: Map<string, DebugModelTotals>;
  /** Individual llm_request records across this file. */
  requests: DebugRequest[];
  /** TTL-only activity markers (epoch ms). Never feed token/credit sums. */
  lastTurnStartMs: number;
  lastTurnEndMs: number;
  lastRequestMs: number;
  lastRequestModel: string;
}

function parseDebugLogLines(content: string): ParsedDebugLog | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) {
    return null;
  }

  let sessionId = "";
  let currentTurn = -1;
  const turnMap = new Map<number, DebugLogTurnTokens>();
  let totalPrompt = 0;
  let totalOutput = 0;
  let totalLlmCalls = 0;
  let totalNanoAiu = 0;
  const childLogFiles = new Map<string, number>();
  // Session-level per-model totals so pre-turn llm_requests (e.g. title
  // generation, which fires before any turn_start) still contribute to
  // per-model attribution.
  const sessionByModel = new Map<string, DebugModelTotals>();
  const sessionRequests: DebugRequest[] = [];
  let lastTurnStartMs = 0;
  let lastTurnEndMs = 0;
  let lastRequestMs = 0;
  let lastRequestModel = "";

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry)) {
      continue;
    }

    const type = entry.type;
    if (type === "session_start") {
      sessionId = typeof entry.sid === "string" ? entry.sid : "";
    } else if (!sessionId && typeof entry.sid === "string" && entry.sid) {
      // Fallback: extract sid from ANY entry type when session_start is missing.
      // This handles debug-logs that resume after a VS Code reload/restart
      // without re-emitting session_start — those files still carry the sid
      // on turn_end, agent_response, llm_request, and other entry types.
      sessionId = entry.sid;
    }

    if (type === "child_session_ref") {
      const childFile = str(entry, "attrs", "childLogFile");
      if (childFile) {
        childLogFiles.set(childFile, currentTurn);
      }
    } else if (type === "turn_start") {
      const tid = get(entry, "attrs", "turnId");
      const parsed = tid !== undefined ? parseInt(String(tid), 10) : NaN;
      currentTurn = Number.isNaN(parsed) ? currentTurn + 1 : parsed;
      const ts = typeof entry.ts === "number" ? entry.ts : 0;
      if (ts > lastTurnStartMs) {
        lastTurnStartMs = ts;
      }
      if (!turnMap.has(currentTurn)) {
        turnMap.set(currentTurn, emptyDebugTurn(currentTurn, ts));
      }
    } else if (type === "turn_end") {
      // TTL-only: an open turn (start > end) means the agent is still
      // generating, so the prompt cache is being refreshed (HOT state).
      const ts = typeof entry.ts === "number" ? entry.ts : 0;
      if (ts > lastTurnEndMs) {
        lastTurnEndMs = ts;
      }
    } else if (type === "llm_request") {
      const attrs = entry.attrs;
      if (!isObj(attrs)) {
        continue;
      }
      const inp = typeof attrs.inputTokens === "number" ? attrs.inputTokens : 0;
      const out = typeof attrs.outputTokens === "number" ? attrs.outputTokens : 0;
      // cache-read tokens: present on Anthropic Opus/Sonnet traces as `cachedTokens`.
      // When absent the field is undefined; default to 0. Used by the debug-log
      // fallback path in dashboardData.ts so the dashboard's LIVE CACHED / TRACE
      // CACHE cells stop showing 0 when OTLP is unavailable.
      const cached = typeof attrs.cachedTokens === "number" ? attrs.cachedTokens : 0;
      const nanoAiu = typeof attrs.copilotUsageNanoAiu === "number" ? attrs.copilotUsageNanoAiu : 0;
      // Per-event model: lets us attribute auxiliary calls (e.g. title
      // generation using gpt-4o-mini, subagents using claude-haiku-4.5) to
      // their actual model instead of collapsing them into the parent turn's
      // single modelFamily. Falls back to "unknown" so per-model rows always
      // have a bucket.
      const reqModel = typeof attrs.model === "string" && attrs.model ? attrs.model : "unknown";
      // Per-event timestamp: prefer the llm_request's own `ts` (when the API
      // call returned), fall back to 0 so we don't regress the turn's existing
      // turn_start timestamp.
      const eventTs = typeof entry.ts === "number" ? entry.ts : 0;
      const debugName = typeof attrs.debugName === "string" ? attrs.debugName : undefined;
      const debugRequest: DebugRequest = {
        timestamp: eventTs ? new Date(eventTs).toISOString() : "",
        model: reqModel,
        prompt: inp,
        output: out,
        cached,
        nanoAiu,
        debugName,
      };
      totalPrompt += inp;
      totalOutput += out;
      totalNanoAiu += nanoAiu;
      totalLlmCalls++;
      sessionRequests.push(debugRequest);
      if (eventTs > lastRequestMs) {
        lastRequestMs = eventTs;
        lastRequestModel = reqModel;
      }
      // Session-level per-model accumulation (covers pre-turn requests too).
      const sm = sessionByModel.get(reqModel) ?? emptyModelTotals();
      sm.prompt += inp;
      sm.output += out;
      sm.cached += cached;
      sm.calls += 1;
      sm.nanoAiu += nanoAiu;
      sessionByModel.set(reqModel, sm);

      if (currentTurn >= 0) {
        if (!turnMap.has(currentTurn)) {
          turnMap.set(currentTurn, emptyDebugTurn(currentTurn));
        }
        const t = turnMap.get(currentTurn)!;
        t.promptTotal += inp;
        t.outputTotal += out;
        t.cachedTotal += cached;
        t.nanoAiu += nanoAiu;
        t.llmCalls++;
        t.requests.push(debugRequest);
        // Accumulate per-model totals for this turn so the dashboard's
        // per-model breakdown can show auxiliary models separately.
        const m = t.byModel.get(reqModel) ?? emptyModelTotals();
        m.prompt += inp;
        m.output += out;
        m.cached += cached;
        m.calls += 1;
        m.nanoAiu += nanoAiu;
        t.byModel.set(reqModel, m);
        // Bump the turn's timestamp to the latest llm_request seen so the
        // dashboard's "most recent turn" picker reflects real last activity.
        if (eventTs > t.timestamp) {
          t.timestamp = eventTs;
        }
        // Track the single most recent llm_request separately so
        // `AIC (last req)` shows one API call's bill, not a turn total.
        if (eventTs >= t.lastRequestTs) {
          t.lastRequestTs = eventTs;
          t.lastRequestNanoAiu = nanoAiu;
        }
      }
    }
  }

  if (!sessionId || totalLlmCalls === 0) {
    return null;
  }

  return {
    sessionId,
    totalPrompt,
    totalOutput,
    totalLlmCalls,
    totalNanoAiu,
    turnMap,
    childLogFiles,
    byModel: sessionByModel,
    requests: sessionRequests,
    lastTurnStartMs,
    lastTurnEndMs,
    lastRequestMs,
    lastRequestModel,
  };
}

/**
 * Parse a debug-log session directory: reads main.jsonl and follows all
 * child_session_ref entries (subagent logs, title logs) to aggregate total usage.
 *
 * Exported so `tests/verify-ttl-from-scan.js` can assert the prompt-cache TTL
 * markers against a real on-disk log tree without re-implementing the parser.
 */
export async function parseDebugLogDir(sessionDir: string): Promise<DebugLogData | null> {
  const mainJsonl = path.join(sessionDir, "main.jsonl");
  let mainContent: string;
  try {
    mainContent = await fsp.readFile(mainJsonl, "utf-8");
  } catch {
    return null;
  }

  const main = parseDebugLogLines(mainContent);
  if (!main) {
    return null;
  }

  // Aggregate child session files and merge into parent turn data
  let totalPrompt = main.totalPrompt;
  let totalOutput = main.totalOutput;
  let totalLlmCalls = main.totalLlmCalls;
  let totalNanoAiu = main.totalNanoAiu;
  const requests = main.requests.slice();
  let lastRequestMs = main.lastRequestMs;
  let lastRequestModel = main.lastRequestModel;

  // Older Copilot versions (and some session boundary conditions) leave
  // `title-*.jsonl` and `runSubagent-*.jsonl` on disk WITHOUT a matching
  // `child_session_ref` entry in main.jsonl. Audit against real
  // workspaceStorage showed 16 such orphan files across 295 sessions,
  // containing 137 llm_request events (mostly subagent haiku rounds + a
  // few title gpt-4o-mini calls). Without this step those calls are
  // silently dropped from all per-model and token totals.
  //
  // Enumerate disk-resident child files and attach any not already
  // referenced as orphans (parentTurn = -1 → attributed to turn 0, the
  // same fallback used for pre-turn title entries below).
  try {
    const dirEntries = await fsp.readdir(sessionDir);
    for (const name of dirEntries) {
      if (!name.endsWith(".jsonl")) continue;
      if (!name.startsWith("title-") && !name.startsWith("runSubagent-")) continue;
      if (!main.childLogFiles.has(name)) {
        main.childLogFiles.set(name, -1);
      }
    }
  } catch {
    /* dir already known-readable (main.jsonl was read above); ignore */
  }

  if (main.childLogFiles.size > 0) {
    const entries = Array.from(main.childLogFiles.entries());
    const childResults = await mapConcurrent(entries, 8, async ([childFile, parentTurn]) => {
      const childPath = path.join(sessionDir, childFile);
      try {
        const content = await fsp.readFile(childPath, "utf-8");
        const parsed = parseDebugLogLines(content);
        return parsed ? { parsed, parentTurn } : null;
      } catch {
        return null;
      }
    });

    for (const result of childResults) {
      if (!result) {
        continue;
      }
      const { parsed: child, parentTurn } = result;
      totalPrompt += child.totalPrompt;
      totalOutput += child.totalOutput;
      totalLlmCalls += child.totalLlmCalls;
      totalNanoAiu += child.totalNanoAiu;
      requests.push(...child.requests);
      // Subagent/title rounds refresh the same prompt cache — take the newest.
      if (child.lastRequestMs > lastRequestMs) {
        lastRequestMs = child.lastRequestMs;
        lastRequestModel = child.lastRequestModel;
      }

      // Merge child credits into the parent turn that spawned it. The
      // `title-*.jsonl` child fires BEFORE any `turn_start` (parentTurn === -1)
      // because Copilot generates the conversation title at session-start,
      // before the user's first turn. Treat that as turn 0 so the title call's
      // small-model AIC (gpt-4o-mini) is attributed instead of orphaned.
      const targetTurnIdx = parentTurn >= 0 ? parentTurn : 0;
      let pt = main.turnMap.get(targetTurnIdx);
      if (!pt) {
        // No turn_start seen yet for the target turn — synthesize an empty
        // one so the pre-turn child (title) has somewhere to attach. Will be
        // populated by any subsequent turn_start / llm_request for the same id.
        pt = emptyDebugTurn(targetTurnIdx);
        main.turnMap.set(targetTurnIdx, pt);
      }
      pt.promptTotal += child.totalPrompt;
      pt.outputTotal += child.totalOutput;
      pt.cachedTotal += Array.from(child.turnMap.values()).reduce((sum, turn) => sum + turn.cachedTotal, 0);
      pt.llmCalls += child.totalLlmCalls;
      pt.nanoAiu += child.totalNanoAiu;
      pt.requests.push(...child.requests);
      for (const req of child.requests) {
        const reqTs = req.timestamp ? Date.parse(req.timestamp) : 0;
        if (reqTs >= pt.lastRequestTs) {
          pt.lastRequestTs = reqTs;
          pt.lastRequestNanoAiu = req.nanoAiu;
        }
        if (reqTs > pt.timestamp) {
          pt.timestamp = reqTs;
        }
      }
      // Merge child's per-model breakdown so the parent turn surfaces
      // auxiliary models (title gpt-4o-mini, subagent haiku) in the
      // dashboard's per-model rows instead of hiding them under the
      // parent's single modelFamily. Use the child's session-level byModel
      // (covers pre-turn llm_requests like `title-*.jsonl`'s single call,
      // which has no `turn_start` and therefore no per-turn bucket).
      mergeByModel(pt.byModel, child.byModel);
    }
  }

  return {
    sessionId: main.sessionId,
    filePath: mainJsonl,
    turns: Array.from(main.turnMap.values()).sort((a, b) => a.turnIndex - b.turnIndex),
    totalPrompt,
    totalOutput,
    totalLlmCalls,
    totalNanoAiu,
    requests,
    lastTurnStartMs: main.lastTurnStartMs,
    lastTurnEndMs: main.lastTurnEndMs,
    lastRequestMs,
    lastRequestModel,
  };
}

/** Discover debug-logs with mtime caching. Follows child_session_ref for full aggregation. */
async function discoverDebugLogsCached(wsRoot: string): Promise<Map<string, DebugLogData>> {
  const map = new Map<string, DebugLogData>();
  const dirs = await listWorkspaceDirsSorted(wsRoot);
  // Empty-window sessions (no folder open) keep their debug logs under the
  // User dir's globalStorage, not under any workspace hash.
  const dlDirs = [
    ...dirs.map(entry => path.join(wsRoot, entry.name, "GitHub.copilot-chat", "debug-logs")),
    path.join(path.dirname(wsRoot), "globalStorage", "github.copilot-chat", "debug-logs"),
  ];

  await mapConcurrent(dlDirs, 16, async dlDir => {
    if (!(await isDirectory(dlDir))) {
      return;
    }

    const sessionDirs = await readDirNames(dlDir);

    for (const sid of sessionDirs) {
      const sessionDir = path.join(dlDir, sid);
      const mainJsonl = path.join(sessionDir, "main.jsonl");
      const mtime = await fileMtime(mainJsonl);
      if (mtime < 0) {
        continue;
      }

      const cached = _debugLogCache.get(mainJsonl);
      if (cached && cached.mtime === mtime) {
        map.set(cached.data.sessionId, cached.data);
      } else {
        const data = await parseDebugLogDir(sessionDir);
        if (data) {
          _debugLogCache.set(mainJsonl, { mtime, data });
          map.set(data.sessionId, data);
        } else {
          _debugLogCache.delete(mainJsonl);
        }
      }
    }
  });

  return map;
}

// ─── Recovery of credits dropped from truncated debug logs ────
//
// Copilot caps each debug-log `main.jsonl` by cutting off its HEAD (the file
// then opens on a half-written line). Every `llm_request` before the cut is
// gone, and with it the `copilotUsageNanoAiu` GitHub billed for it. The
// chatSession file still records `copilotCredits` per user request, and for
// intact sessions that figure equals the debug-log sum to the cent, so the
// shortfall is billed credit the debug log lost, not an estimate.

/** Mirrors `AIC_EFFECTIVE_DATE` in dashboardData.ts, which imports this module and so cannot be imported here. */
const AIC_BILLING_START_MS = Date.UTC(2026, 5, 1);

/** Below this a difference is float noise, not a lost request. */
const CREDIT_EPSILON = 0.005;

/** `debugName` of a request synthesised from chatSession credits rather than read from a debug log. */
export const RECOVERED_DEBUG_NAME = "chatSession.copilotCredits";

export interface RecoveredCredit {
  turnIndex: number;
  startMs: number;
  model: string;
  /** Token mix of the same model's surviving requests in this session. */
  splitTokens?: { prompt: number; output: number; cached: number };
  credits: number;
}

/**
 * Credits the scanner currently counts for one turn, mirroring the branch order
 * every consumer uses: per-request records first, else the turn-level figure.
 */
function turnCountedCredits(t: Turn): number {
  if (t.debugRequests && t.debugRequests.length > 0) {
    let sum = 0;
    for (const req of t.debugRequests) {
      if (Date.parse(req.timestamp) >= AIC_BILLING_START_MS) {
        sum += req.nanoAiu / 1_000_000_000;
      }
    }
    return sum;
  }
  return Date.parse(t.timestamp) >= AIC_BILLING_START_MS ? t.debugAicCredits : 0;
}

/**
 * Credits present in the chatSession but absent from the (head-truncated) debug
 * log of the same session, split over the requests that began before the log's
 * first surviving `llm_request`.
 *
 * The session-level shortfall (`chatSession total − what the scanner counts`) is
 * the hard cap, so a per-request misattribution can shift credit between days
 * but never add any. Only requests that started before the first surviving
 * debug request qualify: a debug log that merely lags the chatSession on the
 * live tail must not be topped up, or the dashboard would overstate until the
 * log catches up.
 */
export function recoverTruncatedDebugCredits(
  chatTurns: ReadonlyArray<Turn>,
  debugRequests: ReadonlyArray<DebugRequest>,
  countedCredits: number
): RecoveredCredit[] {
  const eligible = chatTurns
    .filter(t => (t.chatCredits ?? 0) > 0 && (t.chatStartMs ?? 0) >= AIC_BILLING_START_MS)
    .sort((a, b) => (a.chatStartMs as number) - (b.chatStartMs as number));
  if (eligible.length === 0 || debugRequests.length === 0) {
    return [];
  }

  let chatTotal = 0;
  for (const t of eligible) {
    chatTotal += t.chatCredits as number;
  }
  const shortfall = chatTotal - countedCredits;
  if (shortfall <= CREDIT_EPSILON) {
    return [];
  }

  // A debug request belongs to the latest chat request that started at or
  // before it; anything earlier (title generation) joins the first request.
  const starts = eligible.map(t => t.chatStartMs as number);
  const assigned = new Array<number>(eligible.length).fill(0);
  let firstDebugMs = Infinity;
  for (const req of debugRequests) {
    const ts = Date.parse(req.timestamp);
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (ts < firstDebugMs) {
      firstDebugMs = ts;
    }
    let lo = 0;
    let hi = starts.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= ts) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    assigned[idx] += req.nanoAiu / 1_000_000_000;
  }

  const weights: number[] = [];
  let weightTotal = 0;
  for (let i = 0; i < eligible.length; i++) {
    const t = eligible[i];
    // A turn with no debug overlay already contributes its own chatCredits.
    const lost =
      starts[i] < firstDebugMs && t.debugRequests && t.debugRequests.length > 0
        ? (t.chatCredits as number) - assigned[i]
        : 0;
    const w = lost > CREDIT_EPSILON ? lost : 0;
    weights.push(w);
    weightTotal += w;
  }
  if (weightTotal <= CREDIT_EPSILON) {
    return [];
  }

  const scale = Math.min(weightTotal, shortfall) / weightTotal;
  // The lost requests' own tokens are gone, but the same model's surviving
  // requests in the session show how its credits split across columns.
  const mixByModel = new Map<string, { prompt: number; output: number; cached: number }>();
  for (const req of debugRequests) {
    if (req.nanoAiu <= 0) {
      continue;
    }
    const mix = mixByModel.get(req.model) ?? { prompt: 0, output: 0, cached: 0 };
    mix.prompt += req.prompt;
    mix.output += req.output;
    mix.cached += req.cached;
    mixByModel.set(req.model, mix);
  }
  const out: RecoveredCredit[] = [];
  for (let i = 0; i < eligible.length; i++) {
    if (weights[i] > 0) {
      out.push({
        turnIndex: eligible[i].turnIndex,
        startMs: starts[i],
        model: eligible[i].modelFamily,
        credits: weights[i] * scale,
        splitTokens: mixByModel.get(eligible[i].modelFamily),
      });
    }
  }
  return out;
}

/** Fold a recovered request into a turn through every field consumers read. */
function applyRecoveredCredit(t: Turn, r: RecoveredCredit): void {
  const nanoAiu = r.credits * 1_000_000_000;
  t.debugAicCredits += r.credits;
  t.debugRequests = [
    ...(t.debugRequests ?? []),
    {
      timestamp: new Date(r.startMs).toISOString(),
      model: r.model,
      prompt: 0,
      output: 0,
      cached: 0,
      nanoAiu,
      debugName: RECOVERED_DEBUG_NAME,
      splitTokens: r.splitTokens,
    },
  ];
  const byModel: Record<string, DebugModelTotals> = { ...(t.debugByModel ?? {}) };
  const prior = byModel[r.model] ?? { prompt: 0, output: 0, cached: 0, calls: 0, nanoAiu: 0 };
  byModel[r.model] = { ...prior, nanoAiu: prior.nanoAiu + nanoAiu };
  t.debugByModel = byModel;
}

// ─── File-level mtime cache for incremental scanning ──────────
const _sessionBundleCache = new Map<string, { mtime: number; bundle: SessionBundle }>();
const _debugLogCache = new Map<string, { mtime: number; data: DebugLogData }>();

// ─── Main Scanner (Async) ─────────────────────────────────────

export async function scanWorkspaceStorage(workspaceStorageOverride?: string): Promise<ScanResult> {
  const wsRoot = await getWorkspaceStoragePath(workspaceStorageOverride);

  // Discover all file locations concurrently
  const [wsSessionFiles, emptyWindowFiles, transcriptMap, debugLogMap] = await Promise.all([
    discoverSessionFiles(wsRoot),
    discoverEmptyWindowSessionFiles(wsRoot),
    discoverTranscriptFiles(wsRoot),
    discoverDebugLogsCached(wsRoot),
  ]);
  const sessionFiles = [...wsSessionFiles, ...emptyWindowFiles];

  // Parse session files concurrently with mtime caching
  const bundlesBySession = new Map<string, SessionBundle[]>();

  interface FileWithMtime {
    file: FileEntry;
    mtime: number;
  }
  const filesToProcess: FileWithMtime[] = [];

  // Phase 1: stat all files concurrently to get mtimes
  const mtimes = await mapConcurrent(sessionFiles, 32, async file => {
    return fileMtime(file.path);
  });

  for (let i = 0; i < sessionFiles.length; i++) {
    if (mtimes[i] >= 0) {
      filesToProcess.push({ file: sessionFiles[i], mtime: mtimes[i] });
    }
  }

  // Phase 2: read & parse files that need it (cache miss or mtime changed)
  const filesToRead: Array<{ idx: number; file: FileEntry }> = [];
  const bundles = new Array<SessionBundle | null>(filesToProcess.length);

  for (let i = 0; i < filesToProcess.length; i++) {
    const { file, mtime } = filesToProcess[i];
    const cached = _sessionBundleCache.get(file.path);
    if (cached && cached.mtime === mtime) {
      bundles[i] = cached.bundle;
    } else {
      filesToRead.push({ idx: i, file });
    }
  }

  // Read all cache-miss files concurrently
  await mapConcurrent(filesToRead, 16, async ({ idx, file }) => {
    try {
      const raw = await fsp.readFile(file.path, "utf-8");
      const ext = path.extname(file.path);
      const content = ext === ".json" ? legacyJsonToKind0(raw) : raw;
      const bundle = parseSessionContent(content, file.path, file.wsHash, file.project, path.basename(file.path, ext));
      if (bundle) {
        _sessionBundleCache.set(file.path, { mtime: filesToProcess[idx].mtime, bundle });
      } else {
        _sessionBundleCache.delete(file.path);
      }
      bundles[idx] = bundle;
    } catch {
      _sessionBundleCache.delete(file.path);
      bundles[idx] = null;
    }
  });

  // Collect into session groups
  for (const bundle of bundles) {
    if (!bundle || !bundle.session.sessionId) {
      continue;
    }
    const sid = bundle.session.sessionId;
    const list = bundlesBySession.get(sid) ?? [];
    list.push(bundle);
    bundlesBySession.set(sid, list);
  }

  // Add transcript counts
  for (const [sid, sessionBundles] of bundlesBySession) {
    const tPaths = transcriptMap.get(sid);
    if (tPaths) {
      for (const b of sessionBundles) {
        b.session.transcriptCount = tPaths.length;
        b.session.transcriptPaths = tPaths;
      }
    }
  }

  // Deduplicate: choose canonical for each session_id
  const sessions: Session[] = [];
  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const subagentsList: Subagent[] = [];

  let mirroredSessions = 0;
  let mirrorCopiesPruned = 0;
  let promptPreviews = 0;

  for (const [, sessionBundles] of bundlesBySession) {
    sessionBundles.sort(compareBundles);
    const canonical = sessionBundles[0];

    // Merge source paths from all copies
    const allSourcePaths: string[] = [];
    for (const b of sessionBundles) {
      if (b.session.sourcePath) {
        allSourcePaths.push(b.session.sourcePath);
      }
    }
    canonical.session.sourcePaths = allSourcePaths;
    canonical.session.sourceCount = sessionBundles.length;

    if (sessionBundles.length > 1) {
      mirroredSessions++;
      mirrorCopiesPruned += sessionBundles.length - 1;
    }

    const s = canonical.session as Session;
    sessions.push(s);
    // Dedupe canonical.turns by (sessionId, turnIndex). Chat-session files
    // routinely contain MULTIPLE rows for the same turnIndex — an empty
    // initial row created at turn-start plus the fully-populated row written
    // when the turn settles, and sometimes additional rows with mixed
    // workspaceName values after a workspace rename. Without this dedupe
    // step the per-(sid,turnIndex) debug-log enrichment loop below attaches
    // the same debug data (calls/prompt/output/credits) to every duplicate
    // row, and every downstream consumer that iterates `scan.turns` summing
    // `debugAicCredits` (dashboardData.aicSummary.totalCredits,
    // liveOtel.sessionAIC, sidebar breakdown, status bar dollars) silently
    // double-counts. Verified via tests/verify-no-drift.js — 114 duplicate
    // keys in the wild produced +704 phantom llm_calls / +1869 phantom
    // credits across the user's workspace.
    //
    // Pick rule: keep the row with the highest filled-in token count
    // (promptTokens + outputTokens), then by latest timestamp. This biases
    // toward the "populated" row over an empty initial row while still
    // being deterministic for ties.
    const turnByKey = new Map<string, Turn>();
    for (const t of canonical.turns) {
      const key = `${t.sessionId}|${t.turnIndex}`;
      const existing = turnByKey.get(key);
      if (!existing) {
        turnByKey.set(key, t);
        continue;
      }
      const eFill = (existing.promptTokens || 0) + (existing.outputTokens || 0);
      const tFill = (t.promptTokens || 0) + (t.outputTokens || 0);
      if (tFill > eFill || (tFill === eFill && (t.timestamp || "") > (existing.timestamp || ""))) {
        turnByKey.set(key, t);
      }
    }
    turns.push(...turnByKey.values());
    toolCalls.push(...canonical.toolCalls);
    subagentsList.push(...canonical.subagents);

    if (s.promptPreview) {
      promptPreviews++;
    }
  }

  // Enrich sessions and turns with debug-log token data
  for (const s of sessions) {
    const dbg = debugLogMap.get(s.sessionId);
    if (!dbg) {
      continue;
    }
    s.debugTotalPrompt = dbg.totalPrompt;
    s.debugTotalOutput = dbg.totalOutput;
    s.debugTotalAicCredits = dbg.totalNanoAiu / 1_000_000_000;
    s.debugLogPath = dbg.filePath;
    s.lastTurnStartMs = dbg.lastTurnStartMs;
    s.lastTurnEndMs = dbg.lastTurnEndMs;
    s.lastRequestMs = dbg.lastRequestMs;
    s.lastRequestModel = dbg.lastRequestModel;

    // Enrich individual turns + create synthetic turns for unmatched debug-log entries
    for (const dt of dbg.turns) {
      const matchingTurns = turns.filter(
        t => t.sessionId === s.sessionId && t.turnIndex === dt.turnIndex
      );
      if (matchingTurns.length > 0) {
        for (const t of matchingTurns) {
          t.debugPromptTokens = dt.promptTotal;
          t.debugOutputTokens = dt.outputTotal;
          t.debugCachedTokens = dt.cachedTotal;
          t.debugLlmCalls = dt.llmCalls;
          t.debugAicCredits = dt.nanoAiu / 1_000_000_000;
          t.debugLastRequestAic = dt.lastRequestNanoAiu / 1_000_000_000;
          t.debugLastRequestTs = dt.lastRequestTs
            ? new Date(dt.lastRequestTs).toISOString()
            : "";
          if (dt.byModel.size > 0) {
            t.debugByModel = Object.fromEntries(dt.byModel);
          }
          if (dt.requests.length > 0) {
            t.debugRequests = dt.requests.slice();
          }
        }
      } else if (dt.promptTotal > 0 || dt.outputTotal > 0 || dt.llmCalls > 0) {
        // chatSession hasn't flushed this turn yet — create synthetic turn from debug-log.
        //
        // The `dt.llmCalls > 0` branch covers a real-world edge case verified
        // via tests/verify-no-drift.js: an `llm_request` with `status:"error"`
        // (e.g. timeout, abort, server-side failure) has NO `inputTokens` /
        // `outputTokens` / `copilotUsageNanoAiu` fields. The scanner still
        // counts it in `dt.llmCalls` (a request *was* made), but
        // `dt.promptTotal === 0 && dt.outputTotal === 0`. Without the
        // `llmCalls > 0` predicate, errored calls in turns past the
        // chat-session's last flushed turn are silently dropped from the
        // total request count — a -1 per affected session that breaks the
        // raw-debug-log ↔ scanner.turns parity invariant.
        const ts = dt.timestamp ? new Date(dt.timestamp).toISOString() : s.lastTimestamp || "";
        turns.push({
          sessionId: s.sessionId,
          turnIndex: dt.turnIndex,
          timestamp: ts,
          modelFamily: s.modelFamily || "unknown",
          modelVendor: s.modelVendor || undefined,
          modelProvider: s.modelProvider || undefined,
          promptTokens: 0,
          outputTokens: 0,
          debugPromptTokens: dt.promptTotal,
          debugOutputTokens: dt.outputTotal,
          debugCachedTokens: dt.cachedTotal,
          debugLlmCalls: dt.llmCalls,
          debugAicCredits: dt.nanoAiu / 1_000_000_000,
          debugLastRequestAic: dt.lastRequestNanoAiu / 1_000_000_000,
          debugLastRequestTs: dt.lastRequestTs
            ? new Date(dt.lastRequestTs).toISOString()
            : "",
          debugByModel: dt.byModel.size > 0 ? Object.fromEntries(dt.byModel) : undefined,
          debugRequests: dt.requests.length > 0 ? dt.requests.slice() : undefined,
          toolCallRounds: dt.llmCalls > 1 ? dt.llmCalls - 1 : 0,
          toolCallResults: 0,
          workspaceName: "",
        });
      }
    }

    // The debug log was cut at its head: take back the credits it lost from
    // the chatSession's own per-request figure.
    const sessionTurns = turns.filter(t => t.sessionId === s.sessionId);
    let counted = 0;
    for (const t of sessionTurns) {
      counted += turnCountedCredits(t);
    }
    for (const r of recoverTruncatedDebugCredits(sessionTurns, dbg.requests, counted)) {
      const target = sessionTurns.find(t => t.turnIndex === r.turnIndex && t.chatStartMs === r.startMs);
      if (target) {
        applyRecoveredCredit(target, r);
        s.debugTotalAicCredits += r.credits;
      }
    }
  }

  // Sort sessions by last timestamp desc
  sessions.sort((a, b) => (b.lastTimestamp || "").localeCompare(a.lastTimestamp || ""));

  const transcriptsFound = Array.from(transcriptMap.values()).reduce((s, v) => s + v.length, 0);

  return {
    sessions,
    turns,
    toolCalls,
    subagents: subagentsList,
    stats: {
      sourceFiles: sessionFiles.length,
      canonicalSessions: sessions.length,
      mirroredSessions,
      mirrorCopiesPruned,
      turnsStored: turns.length,
      toolCallsStored: toolCalls.length,
      promptPreviews,
      transcriptsFound,
      debugLogSessions: debugLogMap.size,
    },
  };
}
