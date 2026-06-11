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
}

export interface Turn {
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  modelFamily: string;
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
  toolCallRounds: number;
  toolCallResults: number;
  workspaceName: string;
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
    if (cur === null || cur === undefined || typeof cur !== "object") { return ""; }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : "";
}

/** Safely get a number from an unknown value at a key path */
function num(obj: unknown, ...keys: string[]): number {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") { return 0; }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : 0;
}

/** Safely get a value from an unknown object (returns unknown) */
function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") { return undefined; }
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
  if (p.startsWith("file:///")) { p = p.slice(8); }
  else if (p.startsWith("file://")) { p = p.slice(7); }
  p = decodeURIComponent(p);
  if (/^\/[A-Z]:/i.test(p)) { p = p.slice(1); }
  return p;
}

/**
 * Pull (agentName, description) from a runSubagent tool call's `arguments`
 * field. Accepts either a JSON string or an already-parsed object.
 * Returns sensible defaults when parsing fails or fields are missing.
 */
function extractSubagentArgs(rawArgs: unknown): { agentName: string; description: string } {
  let agentName = "unknown";
  let description = "";
  try {
    const args: unknown = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (isObj(args)) {
      agentName = typeof args.agentName === "string" ? args.agentName : "unknown";
      description = typeof args.description === "string" ? args.description : "";
    }
  } catch { /* ignore */ }
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
function emitTurnAndToolCalls(
  meta: Record<string, unknown>,
  ctx: {
    sessionId: string;
    turnIndex: number;
    modelFamily: string;
    timestamp: string;
    workspaceName: string;
  },
  out: { turns: Turn[]; toolCalls: ToolCall[]; subagents: Subagent[] },
): void {
  const { sessionId, turnIndex, modelFamily, timestamp, workspaceName } = ctx;

  out.turns.push({
    sessionId,
    turnIndex,
    timestamp,
    modelFamily,
    promptTokens: num(meta, "promptTokens"),
    outputTokens: num(meta, "outputTokens"),
    debugPromptTokens: 0,
    debugOutputTokens: 0,
    debugCachedTokens: 0,
    debugLlmCalls: 0,
    debugAicCredits: 0,
    toolCallRounds: isArr(meta.toolCallRounds) ? meta.toolCallRounds.length : 0,
    toolCallResults: isArr(meta.toolCallResults) ? meta.toolCallResults.length : 0,
    workspaceName,
  });

  let callIndex = 0;
  if (isArr(meta.toolCallRounds)) {
    for (const round of meta.toolCallRounds) {
      if (!isObj(round)) { continue; }
      const roundCalls = round.toolCalls;
      if (!isArr(roundCalls)) { continue; }
      for (const tc of roundCalls) {
        if (!isObj(tc)) { continue; }
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
  if (!ms || ms <= 0) { return ""; }
  return new Date(ms).toISOString();
}

function extractWorkspaceName(cacheKey: string | undefined, wsHash: string): string {
  if (!cacheKey) { return `workspace-${wsHash.slice(0, 8)}`; }
  try {
    const p = normalizeFileUri(cacheKey);
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) { return parts.slice(-2).join("/"); }
    if (parts.length === 1) { return parts[0]; }
  } catch { /* ignore */ }
  return `workspace-${wsHash.slice(0, 8)}`;
}

function extractRequestText(requests: unknown[]): string {
  const texts: string[] = [];
  for (const req of requests) {
    if (!isObj(req)) { continue; }
    const msg = req.message;
    if (!isObj(msg)) { continue; }
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
          if (typeof t === "string" && t.trim()) { texts.push(t.trim()); }
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

function parseSessionContent(content: string, filePath: string, wsHash: string, projectName: string): SessionBundle | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) { return null; }

  let sessionId = "";
  let sessionTitle = "";
  let modelName = "unknown";
  let modelFamily = "unknown";
  let modelMultiplier = 1;
  let accountLabel = "";
  let firstTimestamp = "";
  let location = "";
  let agentId = "";
  let promptCount = 0;
  let promptPreview = "";

  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const subagents: Subagent[] = [];

  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isObj(entry)) { continue; }

    const kind = entry.kind;
    const k = entry.k;
    const v = entry.v;

    // kind=0: session metadata
    if (kind === 0 && isObj(v)) {
      sessionId = typeof v.sessionId === "string" ? v.sessionId : "";
      if (typeof v.creationDate === "number") { firstTimestamp = epochMsToIso(v.creationDate); }
      if (typeof v.customTitle === "string") { sessionTitle = v.customTitle; }
      location = typeof v.initialLocation === "string" ? v.initialLocation : "";

      const sel = get(v, "inputState", "selectedModel");
      if (isObj(sel)) {
        const meta = sel.metadata;
        if (isObj(meta)) {
          modelName = typeof meta.name === "string" ? meta.name
            : typeof sel.identifier === "string" ? sel.identifier : "unknown";
          modelFamily = typeof meta.family === "string" ? meta.family : "unknown";
          modelMultiplier = typeof meta.multiplierNumeric === "number" ? meta.multiplierNumeric : 0;
          accountLabel = str(meta, "auth", "accountLabel");
        } else {
          modelName = typeof sel.identifier === "string" ? sel.identifier : "unknown";
        }
      }

      // New format: kind=0 v.requests[] contains embedded turn results
      const vRequests = v.requests;
      if (isArr(vRequests)) {
        for (let ri = 0; ri < vRequests.length; ri++) {
          const req = vRequests[ri];
          if (!isObj(req)) { continue; }
          const meta = get(req, "result", "metadata");
          if (isObj(meta)) {
            const metaTs = num(meta, "requestTimestamp");
            const reqTs = num(req as Record<string, unknown>, "timestamp");
            const timestamp = metaTs ? epochMsToIso(metaTs)
              : reqTs ? epochMsToIso(reqTs) : firstTimestamp;
            const wName = extractWorkspaceName(
              typeof meta.cacheKey === "string" ? meta.cacheKey : undefined, wsHash);
            if (typeof meta.agentId === "string") { agentId = meta.agentId; }
            const reqAgent = get(req, "agent", "id");
            if (typeof reqAgent === "string") { agentId = reqAgent; }

            emitTurnAndToolCalls(
              meta,
              { sessionId, turnIndex: ri, modelFamily, timestamp, workspaceName: wName },
              { turns, toolCalls, subagents },
            );
          } else {
            // No result metadata yet — still count as a turn if there's a timestamp
            const reqTs = num(req as Record<string, unknown>, "timestamp");
            const ts = reqTs ? epochMsToIso(reqTs) : firstTimestamp;
            const reqAgent = get(req, "agent", "id");
            if (typeof reqAgent === "string") { agentId = reqAgent; }
            const hasResponse = "response" in (req as Record<string, unknown>);
            if (ts || hasResponse) {
              turns.push({
                sessionId,
                turnIndex: ri,
                timestamp: ts,
                modelFamily,
                promptTokens: 0,
                outputTokens: 0,
                debugPromptTokens: 0,
                debugOutputTokens: 0,
                debugCachedTokens: 0,
                debugLlmCalls: 0,
                debugAicCredits: 0,
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
              const text = typeof msg.text === "string" ? msg.text.trim()
                : isArr(msg.parts) ? msg.parts.filter((p): p is string => typeof p === "string").join(" ").trim()
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
    if (kind === 1 && isArr(k) && k.length === 3 && k[0] === "requests" && k[2] === "result" && isObj(v)) {
      const turnIndex = typeof k[1] === "number" ? k[1] : parseInt(String(k[1]), 10);
      const meta = v.metadata;
      if (!isObj(meta)) { continue; }

      const metaTs = num(meta, "requestTimestamp");
      const timestamp = metaTs ? epochMsToIso(metaTs) : firstTimestamp;
      const wName = extractWorkspaceName(
        typeof meta.cacheKey === "string" ? meta.cacheKey : undefined, wsHash);
      if (typeof meta.agentId === "string") { agentId = meta.agentId; }

      emitTurnAndToolCalls(
        meta,
        { sessionId, turnIndex, modelFamily, timestamp, workspaceName: wName },
        { turns, toolCalls, subagents },
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

  if (!sessionId) { return null; }

  // Calculate session totals from turns
  const totalPrompt = turns.reduce((s, t) => s + t.promptTokens, 0);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalToolRounds = turns.reduce((s, t) => s + t.toolCallRounds, 0);
  const totalToolResults = turns.reduce((s, t) => s + t.toolCallResults, 0);
  const subagentCallCount = subagents.length;
  const lastTimestamp = turns.length > 0
    ? turns.reduce((best, t) => t.timestamp > best ? t.timestamp : best, "")
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
    if (sa[i] !== sb[i]) { return sb[i] - sa[i]; }
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
          const fp = typeof f === "string" ? f : isObj(f) && typeof f.path === "string" ? f.path : "";
          if (!fp) { return ""; }
          const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
          return parts.length >= 2 ? parts.slice(-2).join("/") : parts[parts.length - 1] || "";
        })
        .filter(Boolean);
      if (names.length > 0) { return names.join(" + "); }
    }
  } catch { /* ignore */ }
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
  candidates.push(path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"));
  candidates.push(path.join(home, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"));

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
    if (await isDirectory(p)) { return p; }
  }
  return defaultWorkspaceStoragePath();
}

/** Check if a path is a directory (non-throwing). */
async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch { return false; }
}

/** Get mtime of a file, or -1 if it doesn't exist / isn't a file. */
async function fileMtime(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st.mtimeMs : -1;
  } catch { return -1; }
}

/** Read directory entries (withFileTypes), returning empty on error. */
async function readDirSafe(p: string): Promise<fs.Dirent[]> {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}

/** Read directory names (string[]), returning empty on error. */
async function readDirNames(p: string): Promise<string[]> {
  try { return await fsp.readdir(p); } catch { return []; }
}

/**
 * List the immediate subdirectories of `wsRoot`, sorted by name.
 * Non-directory entries are filtered out; missing/inaccessible roots yield [].
 */
async function listWorkspaceDirsSorted(wsRoot: string): Promise<fs.Dirent[]> {
  const entries = await readDirSafe(wsRoot);
  return entries
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Process a single workspace directory for session files. */
async function processWorkspaceDirForSessions(
  wsRoot: string,
  dirName: string,
): Promise<FileEntry[]> {
  const wsDir = path.join(wsRoot, dirName);
  const chatDir = path.join(wsDir, "chatSessions");

  if (!await isDirectory(chatDir)) { return []; }

  // Resolve project name from workspace.json
  let projectName = `workspace-${dirName.slice(0, 8)}`;
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
  } catch { /* ignore */ }

  const names = await readDirNames(chatDir);
  const jsonlFiles = names.filter(f => f.endsWith(".jsonl")).sort();

  return jsonlFiles.map(f => ({
    path: path.join(chatDir, f),
    wsHash: dirName,
    project: projectName,
  }));
}

/** Discover all session JSONL files across workspaceStorage. */
async function discoverSessionFiles(wsRoot: string): Promise<FileEntry[]> {
  const dirs = await listWorkspaceDirsSorted(wsRoot);

  const results = await mapConcurrent(dirs, 16, async (entry) => {
    return processWorkspaceDirForSessions(wsRoot, entry.name);
  });

  return results.flat();
}

/** Discover all transcript JSONL files. */
async function discoverTranscriptFiles(wsRoot: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const dirs = await listWorkspaceDirsSorted(wsRoot);

  await mapConcurrent(dirs, 16, async (entry) => {
    const tDir = path.join(wsRoot, entry.name, "GitHub.copilot-chat", "transcripts");
    if (!await isDirectory(tDir)) { return; }

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
}

function parseDebugLogLines(content: string): ParsedDebugLog | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) { return null; }

  let sessionId = "";
  let currentTurn = -1;
  const turnMap = new Map<number, DebugLogTurnTokens>();
  let totalPrompt = 0;
  let totalOutput = 0;
  let totalLlmCalls = 0;
  let totalNanoAiu = 0;
  const childLogFiles = new Map<string, number>();

  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isObj(entry)) { continue; }

    const type = entry.type;
    if (type === "session_start") {
      sessionId = typeof entry.sid === "string" ? entry.sid : "";
    } else if (type === "child_session_ref") {
      const childFile = str(entry, "attrs", "childLogFile");
      if (childFile) { childLogFiles.set(childFile, currentTurn); }
    } else if (type === "turn_start") {
      const tid = get(entry, "attrs", "turnId");
      const parsed = tid !== undefined ? parseInt(String(tid), 10) : NaN;
      currentTurn = Number.isNaN(parsed) ? currentTurn + 1 : parsed;
      if (!turnMap.has(currentTurn)) {
        const ts = typeof entry.ts === "number" ? entry.ts : 0;
        turnMap.set(currentTurn, { turnIndex: currentTurn, promptTotal: 0, outputTotal: 0, cachedTotal: 0, llmCalls: 0, timestamp: ts, nanoAiu: 0 });
      }
    } else if (type === "llm_request") {
      const attrs = entry.attrs;
      if (!isObj(attrs)) { continue; }
      const inp = typeof attrs.inputTokens === "number" ? attrs.inputTokens : 0;
      const out = typeof attrs.outputTokens === "number" ? attrs.outputTokens : 0;
      // cache-read tokens: present on Anthropic Opus/Sonnet traces as `cachedTokens`.
      // When absent the field is undefined; default to 0. Used by the debug-log
      // fallback path in dashboardData.ts so the dashboard's LIVE CACHED / TRACE
      // CACHE cells stop showing 0 when OTLP is unavailable.
      const cached = typeof attrs.cachedTokens === "number" ? attrs.cachedTokens : 0;
      const nanoAiu = typeof attrs.copilotUsageNanoAiu === "number" ? attrs.copilotUsageNanoAiu : 0;
      // Per-event timestamp: prefer the llm_request's own `ts` (when the API
      // call returned), fall back to 0 so we don't regress the turn's existing
      // turn_start timestamp.
      const eventTs = typeof entry.ts === "number" ? entry.ts : 0;
      totalPrompt += inp;
      totalOutput += out;
      totalNanoAiu += nanoAiu;
      totalLlmCalls++;

      if (currentTurn >= 0) {
        if (!turnMap.has(currentTurn)) {
          turnMap.set(currentTurn, { turnIndex: currentTurn, promptTotal: 0, outputTotal: 0, cachedTotal: 0, llmCalls: 0, timestamp: 0, nanoAiu: 0 });
        }
        const t = turnMap.get(currentTurn)!;
        t.promptTotal += inp;
        t.outputTotal += out;
        t.cachedTotal += cached;
        t.nanoAiu += nanoAiu;
        t.llmCalls++;
        // Bump the turn's timestamp to the latest llm_request seen so the
        // dashboard's "most recent turn" picker reflects real last activity.
        if (eventTs > t.timestamp) { t.timestamp = eventTs; }
      }
    }
  }

  if (!sessionId || totalLlmCalls === 0) { return null; }

  return { sessionId, totalPrompt, totalOutput, totalLlmCalls, totalNanoAiu, turnMap, childLogFiles };
}

/**
 * Parse a debug-log session directory: reads main.jsonl and follows all
 * child_session_ref entries (subagent logs, title logs) to aggregate total usage.
 */
async function parseDebugLogDir(sessionDir: string): Promise<DebugLogData | null> {
  const mainJsonl = path.join(sessionDir, "main.jsonl");
  let mainContent: string;
  try { mainContent = await fsp.readFile(mainJsonl, "utf-8"); } catch { return null; }

  const main = parseDebugLogLines(mainContent);
  if (!main) { return null; }

  // Aggregate child session files and merge into parent turn data
  let totalPrompt = main.totalPrompt;
  let totalOutput = main.totalOutput;
  let totalLlmCalls = main.totalLlmCalls;
  let totalNanoAiu = main.totalNanoAiu;

  if (main.childLogFiles.size > 0) {
    const entries = Array.from(main.childLogFiles.entries());
    const childResults = await mapConcurrent(entries, 8, async ([childFile, parentTurn]) => {
      const childPath = path.join(sessionDir, childFile);
      try {
        const content = await fsp.readFile(childPath, "utf-8");
        const parsed = parseDebugLogLines(content);
        return parsed ? { parsed, parentTurn } : null;
      } catch { return null; }
    });

    for (const result of childResults) {
      if (!result) { continue; }
      const { parsed: child, parentTurn } = result;
      totalPrompt += child.totalPrompt;
      totalOutput += child.totalOutput;
      totalLlmCalls += child.totalLlmCalls;
      totalNanoAiu += child.totalNanoAiu;

      // Merge child credits into the parent turn that spawned it
      if (parentTurn >= 0) {
        const pt = main.turnMap.get(parentTurn);
        if (pt) {
          pt.promptTotal += child.totalPrompt;
          pt.outputTotal += child.totalOutput;
          pt.llmCalls += child.totalLlmCalls;
          pt.nanoAiu += child.totalNanoAiu;
        }
      }
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
  };
}

/** Discover debug-logs with mtime caching. Follows child_session_ref for full aggregation. */
async function discoverDebugLogsCached(wsRoot: string): Promise<Map<string, DebugLogData>> {
  const map = new Map<string, DebugLogData>();
  const dirs = await listWorkspaceDirsSorted(wsRoot);

  await mapConcurrent(dirs, 16, async (entry) => {
    const dlDir = path.join(wsRoot, entry.name, "GitHub.copilot-chat", "debug-logs");
    if (!await isDirectory(dlDir)) { return; }

    const sessionDirs = await readDirNames(dlDir);

    for (const sid of sessionDirs) {
      const sessionDir = path.join(dlDir, sid);
      const mainJsonl = path.join(sessionDir, "main.jsonl");
      const mtime = await fileMtime(mainJsonl);
      if (mtime < 0) { continue; }

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

// ─── File-level mtime cache for incremental scanning ──────────
const _sessionBundleCache = new Map<string, { mtime: number; bundle: SessionBundle }>();
const _debugLogCache = new Map<string, { mtime: number; data: DebugLogData }>();

// ─── Main Scanner (Async) ─────────────────────────────────────

export async function scanWorkspaceStorage(workspaceStorageOverride?: string): Promise<ScanResult> {
  const wsRoot = await getWorkspaceStoragePath(workspaceStorageOverride);

  // Discover all file locations concurrently
  const [sessionFiles, transcriptMap, debugLogMap] = await Promise.all([
    discoverSessionFiles(wsRoot),
    discoverTranscriptFiles(wsRoot),
    discoverDebugLogsCached(wsRoot),
  ]);

  // Parse session files concurrently with mtime caching
  const bundlesBySession = new Map<string, SessionBundle[]>();

  interface FileWithMtime { file: FileEntry; mtime: number }
  const filesToProcess: FileWithMtime[] = [];

  // Phase 1: stat all files concurrently to get mtimes
  const mtimes = await mapConcurrent(sessionFiles, 32, async (file) => {
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
      const content = await fsp.readFile(file.path, "utf-8");
      const bundle = parseSessionContent(content, file.path, file.wsHash, file.project);
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
    if (!bundle || !bundle.session.sessionId) { continue; }
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
      if (b.session.sourcePath) { allSourcePaths.push(b.session.sourcePath); }
    }
    canonical.session.sourcePaths = allSourcePaths;
    canonical.session.sourceCount = sessionBundles.length;

    if (sessionBundles.length > 1) {
      mirroredSessions++;
      mirrorCopiesPruned += sessionBundles.length - 1;
    }

    const s = canonical.session as Session;
    sessions.push(s);
    turns.push(...canonical.turns);
    toolCalls.push(...canonical.toolCalls);
    subagentsList.push(...canonical.subagents);

    if (s.promptPreview) { promptPreviews++; }
  }

  // Enrich sessions and turns with debug-log token data
  for (const s of sessions) {
    const dbg = debugLogMap.get(s.sessionId);
    if (!dbg) { continue; }
    s.debugTotalPrompt = dbg.totalPrompt;
    s.debugTotalOutput = dbg.totalOutput;
    s.debugTotalAicCredits = dbg.totalNanoAiu / 1_000_000_000;
    s.debugLogPath = dbg.filePath;

    // Enrich individual turns + create synthetic turns for unmatched debug-log entries
    for (const dt of dbg.turns) {
      const matchingTurns = turns.filter(t => t.sessionId === s.sessionId && t.turnIndex === dt.turnIndex);
      if (matchingTurns.length > 0) {
        for (const t of matchingTurns) {
          t.debugPromptTokens = dt.promptTotal;
          t.debugOutputTokens = dt.outputTotal;
          t.debugCachedTokens = dt.cachedTotal;
          t.debugLlmCalls = dt.llmCalls;
          t.debugAicCredits = dt.nanoAiu / 1_000_000_000;
        }
      } else if (dt.promptTotal > 0 || dt.outputTotal > 0) {
        // chatSession hasn't flushed this turn yet — create synthetic turn from debug-log
        const ts = dt.timestamp ? new Date(dt.timestamp).toISOString() : (s.lastTimestamp || "");
        turns.push({
          sessionId: s.sessionId,
          turnIndex: dt.turnIndex,
          timestamp: ts,
          modelFamily: s.modelFamily || "unknown",
          promptTokens: 0,
          outputTokens: 0,
          debugPromptTokens: dt.promptTotal,
          debugOutputTokens: dt.outputTotal,
          debugCachedTokens: dt.cachedTotal,
          debugLlmCalls: dt.llmCalls,
          debugAicCredits: dt.nanoAiu / 1_000_000_000,
          toolCallRounds: dt.llmCalls > 1 ? dt.llmCalls - 1 : 0,
          toolCallResults: 0,
          workspaceName: "",
        });
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
