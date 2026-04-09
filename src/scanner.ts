/**
 * scanner.ts — Scan VS Code chatSession JSONL files from workspaceStorage.
 * Extracts sessions, turns, tool calls, subagents, and prompt previews.
 * Ports the logic from scanner.py to TypeScript (in-memory, no SQLite).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
  turnCount: number;
  toolCallRounds: number;
  toolCallResults: number;
  subagentCalls: number;
  sourcePaths: string[];
  transcriptPaths: string[];
}

export interface Turn {
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  modelFamily: string;
  promptTokens: number;
  outputTokens: number;
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
}

// ─── Helpers ──────────────────────────────────────────────────

function epochMsToIso(ms: number): string {
  if (!ms || ms <= 0) { return ""; }
  return new Date(ms).toISOString();
}

function extractWorkspaceName(cacheKey: string | undefined, wsHash: string): string {
  if (!cacheKey) { return `workspace-${wsHash.slice(0, 8)}`; }
  try {
    let p = cacheKey;
    if (p.startsWith("file:///")) { p = p.slice(8); }
    else if (p.startsWith("file://")) { p = p.slice(7); }
    p = decodeURIComponent(p);
    // Remove drive letter on Windows
    if (/^\/[A-Z]:/i.test(p)) { p = p.slice(1); }
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) { return parts.slice(-2).join("/"); }
    if (parts.length === 1) { return parts[0]; }
  } catch { /* ignore */ }
  return `workspace-${wsHash.slice(0, 8)}`;
}

function extractRequestText(requests: any[]): string {
  const texts: string[] = [];
  if (!Array.isArray(requests)) { return ""; }
  for (const req of requests) {
    const msg = req?.message;
    if (!msg) { continue; }
    if (typeof msg.text === "string" && msg.text.trim()) {
      texts.push(msg.text.trim());
      continue;
    }
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (typeof part === "string" && part.trim()) {
          texts.push(part.trim());
        } else if (part && typeof part === "object") {
          const t = part.text ?? part.value ?? part.markdown ?? part.content;
          if (typeof t === "string" && t.trim()) { texts.push(t.trim()); }
        }
      }
    }
  }
  const joined = texts.join(" | ").replace(/\s+/g, " ").trim();
  return joined.length > 180 ? joined.slice(0, 177) + "..." : joined;
}

// ─── JSONL Parser ─────────────────────────────────────────────

interface SessionBundle {
  session: Partial<Session>;
  turns: Turn[];
  toolCalls: ToolCall[];
  subagents: Subagent[];
}

function parseSessionFile(filePath: string, wsHash: string, projectName: string): SessionBundle | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch { return null; }

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
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const kind = entry.kind;
    const k = entry.k;
    const v = entry.v;

    // kind=0: session metadata
    if (kind === 0 && v) {
      sessionId = v.sessionId ?? "";
      if (v.creationDate) { firstTimestamp = epochMsToIso(v.creationDate); }
      if (v.customTitle && typeof v.customTitle === "string") { sessionTitle = v.customTitle; }
      location = v.initialLocation ?? "";

      const sel = v.inputState?.selectedModel;
      if (sel) {
        const meta = sel.metadata;
        if (meta) {
          modelName = meta.name ?? sel.identifier ?? "unknown";
          modelFamily = meta.family ?? "unknown";
          modelMultiplier = meta.multiplierNumeric ?? 1;
          accountLabel = meta.auth?.accountLabel ?? "";
        } else {
          modelName = sel.identifier ?? "unknown";
        }
      }

      // New format: kind=0 v.requests[] contains embedded turn results
      if (Array.isArray(v.requests)) {
        for (let ri = 0; ri < v.requests.length; ri++) {
          const req = v.requests[ri];
          if (!req) { continue; }
          const meta = req.result?.metadata;
          if (meta) {
            const timestamp = meta.requestTimestamp ? epochMsToIso(meta.requestTimestamp)
              : (req.timestamp ? epochMsToIso(req.timestamp) : firstTimestamp);
            const wName = extractWorkspaceName(meta.cacheKey, wsHash);
            if (meta.agentId) { agentId = meta.agentId; }
            if (req.agent?.id) { agentId = req.agent.id; }

            turns.push({
              sessionId,
              turnIndex: ri,
              timestamp,
              modelFamily,
              promptTokens: meta.promptTokens ?? 0,
              outputTokens: meta.outputTokens ?? 0,
              toolCallRounds: Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds.length : 0,
              toolCallResults: Array.isArray(meta.toolCallResults) ? meta.toolCallResults.length : 0,
              workspaceName: wName,
            });

            // Extract tool calls from embedded requests
            let callIndex = 0;
            if (Array.isArray(meta.toolCallRounds)) {
              for (const round of meta.toolCallRounds) {
                if (!Array.isArray(round?.toolCalls)) { continue; }
                for (const tc of round.toolCalls) {
                  const toolName = tc?.name ?? "unknown";
                  const isSub = toolName === "runSubagent";
                  toolCalls.push({ sessionId, turnIndex: ri, callIndex, toolName, isSubagent: isSub });
                  if (isSub) {
                    let aName = "unknown";
                    let desc = "";
                    try {
                      const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
                      aName = args?.agentName ?? "unknown";
                      desc = args?.description ?? "";
                    } catch { /* ignore */ }
                    subagents.push({ sessionId, turnIndex: ri, callIndex, agentName: aName, description: desc });
                  }
                  callIndex++;
                }
              }
            }
          } else {
            // No result metadata yet — still count as a turn if there's a timestamp
            const ts = req.timestamp ? epochMsToIso(req.timestamp) : firstTimestamp;
            if (req.agent?.id) { agentId = req.agent.id; }
            if (ts || req.response) {
              turns.push({
                sessionId,
                turnIndex: ri,
                timestamp: ts,
                modelFamily,
                promptTokens: 0,
                outputTokens: 0,
                toolCallRounds: 0,
                toolCallResults: 0,
                workspaceName: extractWorkspaceName(undefined, wsHash),
              });
            }
          }

          // Extract prompt preview from embedded request message
          if (ri === 0 && !promptPreview) {
            const msg = req.message;
            if (msg) {
              const text = typeof msg.text === "string" ? msg.text.trim()
                : Array.isArray(msg.parts) ? msg.parts.filter((p: any) => typeof p === "string").join(" ").trim()
                : "";
              if (text) {
                promptPreview = text.length > 180 ? text.slice(0, 177) + "..." : text;
                promptCount = v.requests.length;
              }
            }
          }
        }
      }
      continue;
    }

    // kind=1, k=["customTitle"]: session title
    if (kind === 1 && Array.isArray(k) && k[0] === "customTitle" && typeof v === "string") {
      sessionTitle = v;
      continue;
    }

    // kind=1, k=["requests", N, "result"]: turn result
    if (kind === 1 && Array.isArray(k) && k.length === 3 && k[0] === "requests" && k[2] === "result" && v) {
      const turnIndex = typeof k[1] === "number" ? k[1] : parseInt(String(k[1]), 10);
      const meta = v.metadata;
      if (!meta) { continue; }

      const timestamp = meta.requestTimestamp ? epochMsToIso(meta.requestTimestamp) : firstTimestamp;
      const wName = extractWorkspaceName(meta.cacheKey, wsHash);
      if (meta.agentId) { agentId = meta.agentId; }

      turns.push({
        sessionId,
        turnIndex,
        timestamp,
        modelFamily,
        promptTokens: meta.promptTokens ?? 0,
        outputTokens: meta.outputTokens ?? 0,
        toolCallRounds: Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds.length : 0,
        toolCallResults: Array.isArray(meta.toolCallResults) ? meta.toolCallResults.length : 0,
        workspaceName: wName,
      });

      // Tool calls
      let callIndex = 0;
      if (Array.isArray(meta.toolCallRounds)) {
        for (const round of meta.toolCallRounds) {
          if (!Array.isArray(round?.toolCalls)) { continue; }
          for (const tc of round.toolCalls) {
            const toolName = tc?.name ?? "unknown";
            const isSub = toolName === "runSubagent";
            toolCalls.push({
              sessionId,
              turnIndex,
              callIndex,
              toolName,
              isSubagent: isSub,
            });

            if (isSub) {
              let agentName = "unknown";
              let desc = "";
              try {
                const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
                agentName = args?.agentName ?? "unknown";
                desc = args?.description ?? "";
              } catch { /* ignore */ }
              subagents.push({ sessionId, turnIndex, callIndex, agentName, description: desc });
            }
            callIndex++;
          }
        }
      }
      continue;
    }

    // kind=2, k=["requests"]: latest prompt snapshot
    if (kind === 2 && Array.isArray(k) && k[0] === "requests" && Array.isArray(v)) {
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
      turnCount: turns.length,
      toolCallRounds: totalToolRounds,
      toolCallResults: totalToolResults,
      subagentCalls: subagentCallCount,
      sourcePaths: [filePath],
      transcriptPaths: [],
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

// ─── Main Scanner ─────────────────────────────────────────────

function resolveWorkspaceFile(wsUri: string, wsHash: string): string {
  try {
    let p = wsUri;
    if (p.startsWith("file:///")) { p = p.slice(8); }
    else if (p.startsWith("file://")) { p = p.slice(7); }
    p = decodeURIComponent(p);
    if (/^\/[A-Z]:/i.test(p)) { p = p.slice(1); }

    const wsContent = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (Array.isArray(wsContent?.folders) && wsContent.folders.length > 0) {
      const names = wsContent.folders
        .map((f: any) => {
          const fp = typeof f === "string" ? f : f?.path;
          if (!fp) { return ""; }
          const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
          return parts.length >= 2 ? parts.slice(-2).join("/") : parts[parts.length - 1] || "";
        })
        .filter(Boolean);
      if (names.length > 0) { return names.join(" + "); }
    }
  } catch { /* ignore */ }
  // Fallback: workspace file doesn't exist anymore, show clean name
  return `multi-root-${wsHash.slice(0, 8)}`;
}

function getWorkspaceStoragePath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Code", "User", "workspaceStorage");
}

function discoverSessionFiles(wsRoot: string): Array<{ path: string; wsHash: string; project: string }> {
  const files: Array<{ path: string; wsHash: string; project: string }> = [];
  if (!fs.existsSync(wsRoot)) { return files; }

  let dirs: string[];
  try { dirs = fs.readdirSync(wsRoot); } catch { return files; }

  for (const dirName of dirs.sort()) {
    const wsDir = path.join(wsRoot, dirName);
    try { if (!fs.statSync(wsDir).isDirectory()) { continue; } } catch { continue; }

    const chatDir = path.join(wsDir, "chatSessions");
    try { if (!fs.statSync(chatDir).isDirectory()) { continue; } } catch { continue; }

    // Try to find project name from workspace.json
    let projectName = `workspace-${dirName.slice(0, 8)}`;
    const workspaceJsonPath = path.join(wsDir, "workspace.json");
    try {
      const wsJson = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf-8"));
      if (typeof wsJson?.folder === "string") {
        // Single-folder workspace
        projectName = extractWorkspaceName(wsJson.folder, dirName);
      } else if (typeof wsJson?.workspace === "string") {
        // Multi-root workspace — resolve the .code-workspace file to get folder names
        projectName = resolveWorkspaceFile(wsJson.workspace, dirName);
      }
    } catch { /* ignore */ }

    let jsonlFiles: string[];
    try { jsonlFiles = fs.readdirSync(chatDir).filter(f => f.endsWith(".jsonl")).sort(); } catch { continue; }

    for (const f of jsonlFiles) {
      files.push({ path: path.join(chatDir, f), wsHash: dirName, project: projectName });
    }
  }

  return files;
}

function discoverTranscriptFiles(wsRoot: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(wsRoot)) { return map; }

  let dirs: string[];
  try { dirs = fs.readdirSync(wsRoot); } catch { return map; }

  for (const dirName of dirs.sort()) {
    const tDir = path.join(wsRoot, dirName, "GitHub.copilot-chat", "transcripts");
    try { if (!fs.statSync(tDir).isDirectory()) { continue; } } catch { continue; }

    let files: string[];
    try { files = fs.readdirSync(tDir).filter(f => f.endsWith(".jsonl")).sort(); } catch { continue; }

    for (const f of files) {
      const stem = path.basename(f, ".jsonl");
      const list = map.get(stem) ?? [];
      list.push(path.join(tDir, f));
      map.set(stem, list);
    }
  }

  return map;
}

export function scanWorkspaceStorage(): ScanResult {
  const wsRoot = getWorkspaceStoragePath();
  const sessionFiles = discoverSessionFiles(wsRoot);
  const transcriptMap = discoverTranscriptFiles(wsRoot);

  // Parse all session files
  const bundlesBySession = new Map<string, SessionBundle[]>();
  for (const file of sessionFiles) {
    const bundle = parseSessionFile(file.path, file.wsHash, file.project);
    if (!bundle || !bundle.session.sessionId) { continue; }
    const sid = bundle.session.sessionId;
    const list = bundlesBySession.get(sid) ?? [];
    list.push(bundle);
    bundlesBySession.set(sid, list);
  }

  // Add transcript counts
  for (const [sid, bundles] of bundlesBySession) {
    const tPaths = transcriptMap.get(sid);
    if (tPaths) {
      for (const b of bundles) {
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

  for (const [, bundles] of bundlesBySession) {
    bundles.sort(compareBundles);
    const canonical = bundles[0];

    // Merge source paths from all copies
    const allSourcePaths: string[] = [];
    for (const b of bundles) {
      if (b.session.sourcePath) { allSourcePaths.push(b.session.sourcePath); }
    }
    canonical.session.sourcePaths = allSourcePaths;
    canonical.session.sourceCount = bundles.length;

    if (bundles.length > 1) {
      mirroredSessions++;
      mirrorCopiesPruned += bundles.length - 1;
    }

    const s = canonical.session as Session;
    sessions.push(s);
    turns.push(...canonical.turns);
    toolCalls.push(...canonical.toolCalls);
    subagentsList.push(...canonical.subagents);

    if (s.promptPreview) { promptPreviews++; }
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
    },
  };
}
