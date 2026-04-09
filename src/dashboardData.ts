/**
 * dashboardData.ts — Aggregate scanner results into dashboard-ready data.
 * Ports get_dashboard_data() from dashboard.py to TypeScript.
 */

import { ScanResult, Session, Turn, ToolCall, Subagent, ScanStats } from "./scanner";
import { LiveStats } from "./otelReceiver";

// ─── Dashboard Data Types ─────────────────────────────────────

export interface DailyRow {
  day: string;
  model: string;
  prompt: number;
  output: number;
  toolRounds: number;
  turns: number;
}

export interface ToolRow {
  sessionId: string;
  toolName: string;
  count: number;
}

export interface SubagentRow {
  sessionId: string;
  agentName: string;
  count: number;
}

export interface SessionView {
  sessionId: string;
  sessionShort: string;
  project: string;
  title: string;
  promptCount: number;
  promptPreview: string;
  transcriptCount: number;
  sources: number;
  last: string;
  lastDate: string;
  durationMin: number;
  modelName: string;
  model: string;
  multiplier: number;
  account: string;
  agentId: string;
  location: string;
  turns: number;
  prompt: number;
  output: number;
  toolRounds: number;
  toolCalls: number;
  subagents: number;
  sourcePaths: string[];
  transcriptPaths: string[];
}

export interface DashboardData {
  allModels: string[];
  dailyByModel: DailyRow[];
  sessionsAll: SessionView[];
  toolsAll: ToolRow[];
  subagentsAll: SubagentRow[];
  liveOtel: LiveOtelData;
  scanStats: ScanStats;
  generatedAt: string;
}

export interface LiveOtelData {
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
  traceCached: number;
  metricCached: number;
  lastSeen: string;
  byModel: Array<{
    model: string;
    requests: number;
    prompt: number;
    completion: number;
    traceCached: number;
    metricCached: number;
    cached: number;
  }>;
}

// ─── Aggregation ──────────────────────────────────────────────

function computeDaily(turns: Turn[]): DailyRow[] {
  const map = new Map<string, DailyRow>();
  for (const t of turns) {
    if (!t.timestamp) { continue; }
    const day = t.timestamp.slice(0, 10);
    const model = t.modelFamily || "unknown";
    const key = `${day}:${model}`;
    const existing = map.get(key);
    if (existing) {
      existing.prompt += t.promptTokens;
      existing.output += t.outputTokens;
      existing.toolRounds += t.toolCallRounds;
      existing.turns++;
    } else {
      map.set(key, { day, model, prompt: t.promptTokens, output: t.outputTokens, toolRounds: t.toolCallRounds, turns: 1 });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

function computeTools(toolCalls: ToolCall[]): ToolRow[] {
  const map = new Map<string, ToolRow>();
  for (const tc of toolCalls) {
    const key = `${tc.sessionId}:${tc.toolName}`;
    const existing = map.get(key);
    if (existing) { existing.count++; }
    else { map.set(key, { sessionId: tc.sessionId, toolName: tc.toolName, count: 1 }); }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function computeSubagents(subagents: Subagent[]): SubagentRow[] {
  const map = new Map<string, SubagentRow>();
  for (const sa of subagents) {
    const key = `${sa.sessionId}:${sa.agentName}`;
    const existing = map.get(key);
    if (existing) { existing.count++; }
    else { map.set(key, { sessionId: sa.sessionId, agentName: sa.agentName, count: 1 }); }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function computeSessionViews(sessions: Session[], toolCalls: ToolCall[]): SessionView[] {
  // Tool call counts per session
  const toolCountMap = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCountMap.set(tc.sessionId, (toolCountMap.get(tc.sessionId) ?? 0) + 1);
  }

  return sessions.map(s => {
    let durationMin = 0;
    if (s.firstTimestamp && s.lastTimestamp) {
      const start = new Date(s.firstTimestamp).getTime();
      const end = new Date(s.lastTimestamp).getTime();
      if (end > start) { durationMin = Math.round((end - start) / 60000 * 10) / 10; }
    }

    return {
      sessionId: s.sessionId,
      sessionShort: s.sessionId.slice(0, 8),
      project: s.projectName || "unknown",
      title: s.sessionTitle || "",
      promptCount: s.promptCount,
      promptPreview: s.promptPreview || "",
      transcriptCount: s.transcriptCount,
      sources: s.sourceCount,
      last: (s.lastTimestamp || "").slice(0, 16).replace("T", " "),
      lastDate: (s.lastTimestamp || "").slice(0, 10),
      durationMin,
      modelName: s.modelName || "unknown",
      model: s.modelFamily || "unknown",
      multiplier: s.modelMultiplier,
      account: s.accountLabel || "",
      agentId: s.agentId || "",
      location: s.location || "",
      turns: s.turnCount,
      prompt: s.totalPromptTokens,
      output: s.totalOutputTokens,
      toolRounds: s.toolCallRounds,
      toolCalls: toolCountMap.get(s.sessionId) ?? 0,
      subagents: s.subagentCalls,
      sourcePaths: s.sourcePaths || [],
      transcriptPaths: s.transcriptPaths || [],
    };
  });
}

function computeAllModels(turns: Turn[]): string[] {
  const map = new Map<string, number>();
  for (const t of turns) {
    const m = t.modelFamily || "unknown";
    map.set(m, (map.get(m) ?? 0) + t.promptTokens + t.outputTokens);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}

// ─── Build Dashboard Data ─────────────────────────────────────

export function buildDashboardData(scan: ScanResult, liveStats: LiveStats | null): DashboardData {
  const allModels = computeAllModels(scan.turns);
  const dailyByModel = computeDaily(scan.turns);
  const sessionsAll = computeSessionViews(scan.sessions, scan.toolCalls);
  const toolsAll = computeTools(scan.toolCalls);
  const subagentsAll = computeSubagents(scan.subagents);

  // Live OTel
  let liveOtel: LiveOtelData;
  if (liveStats && liveStats.requests > 0) {
    const byModel = Array.from(liveStats.byModel.values()).map(m => ({
      model: m.model,
      requests: m.requests,
      prompt: m.prompt,
      completion: m.completion,
      traceCached: m.traceCached,
      metricCached: m.metricCached,
      cached: m.cached,
    }));
    liveOtel = {
      requests: liveStats.requests,
      prompt: liveStats.prompt,
      completion: liveStats.completion,
      cached: liveStats.cached,
      traceCached: liveStats.traceCached,
      metricCached: liveStats.metricCached,
      lastSeen: liveStats.lastSeen,
      byModel,
    };
  } else {
    liveOtel = { requests: 0, prompt: 0, completion: 0, cached: 0, traceCached: 0, metricCached: 0, lastSeen: "", byModel: [] };
  }

  return {
    allModels,
    dailyByModel,
    sessionsAll,
    toolsAll,
    subagentsAll,
    liveOtel,
    scanStats: scan.stats,
    generatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}
