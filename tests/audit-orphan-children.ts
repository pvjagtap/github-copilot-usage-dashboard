/**
 * Audit: find debug-log child files (title-*.jsonl, runSubagent-*.jsonl) that
 * exist on disk but are NOT referenced by any `child_session_ref` entry in the
 * sibling main.jsonl.
 *
 * If any orphans exist, the current scanner.ts is silently dropping their
 * llm_request credits — main.jsonl is the only thing it reads, and child files
 * are only opened when main.jsonl explicitly references them.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function workspaceStorageRoot(): string {
  return path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage");
}

interface OrphanReport {
  sessionDir: string;
  orphans: string[];
  referenced: string[];
  filesOnDisk: string[];
}

function listSessionDirs(root: string): string[] {
  const out: string[] = [];
  let workspaces: string[];
  try {
    workspaces = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    const dlDir = path.join(root, ws, "GitHub.copilot-chat", "debug-logs");
    let sessions: string[];
    try {
      sessions = fs.readdirSync(dlDir);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const sessionDir = path.join(dlDir, sid);
      if (fs.existsSync(path.join(sessionDir, "main.jsonl"))) {
        out.push(sessionDir);
      }
    }
  }
  return out;
}

function extractReferencedChildren(mainJsonl: string): Set<string> {
  const refs = new Set<string>();
  let content: string;
  try {
    content = fs.readFileSync(mainJsonl, "utf-8");
  } catch {
    return refs;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "child_session_ref") {
      const childFile = entry?.attrs?.childLogFile;
      if (typeof childFile === "string") refs.add(childFile);
    }
  }
  return refs;
}

function listChildFiles(sessionDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }
  return entries.filter(name =>
    (name.startsWith("title-") || name.startsWith("runSubagent-")) && name.endsWith(".jsonl")
  );
}

function audit(): void {
  const root = workspaceStorageRoot();
  const sessions = listSessionDirs(root);
  console.log(`Scanning ${sessions.length} debug-log session dirs under ${root}\n`);

  const reports: OrphanReport[] = [];
  let totalOrphans = 0;
  let totalChildren = 0;

  for (const sessionDir of sessions) {
    const filesOnDisk = listChildFiles(sessionDir);
    if (filesOnDisk.length === 0) continue;
    totalChildren += filesOnDisk.length;

    const referenced = extractReferencedChildren(path.join(sessionDir, "main.jsonl"));
    const orphans = filesOnDisk.filter(f => !referenced.has(f));
    if (orphans.length > 0) {
      totalOrphans += orphans.length;
      reports.push({
        sessionDir,
        orphans,
        referenced: Array.from(referenced),
        filesOnDisk,
      });
    }
  }

  console.log(`Total child files on disk     : ${totalChildren}`);
  console.log(`Total referenced by main.jsonl: ${totalChildren - totalOrphans}`);
  console.log(`Total ORPHANS (silently dropped by scanner.ts): ${totalOrphans}\n`);

  if (reports.length === 0) {
    console.log("OK: every title-*.jsonl / runSubagent-*.jsonl is referenced.");
    return;
  }

  console.log(`Sessions with orphans: ${reports.length}\n`);
  // Print up to first 10 reports with breakdown by category
  let titleOrphans = 0;
  let subagentOrphans = 0;
  let totalOrphanCalls = 0;
  let totalOrphanNanoAiu = 0;
  const orphanByModel = new Map<string, { calls: number; nanoAiu: number }>();

  for (const r of reports) {
    for (const o of r.orphans) {
      if (o.startsWith("title-")) titleOrphans++;
      else if (o.startsWith("runSubagent-")) subagentOrphans++;
      // Count llm_requests inside this orphan
      try {
        const content = fs.readFileSync(path.join(r.sessionDir, o), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry?.type === "llm_request") {
            totalOrphanCalls++;
            const nano = typeof entry?.attrs?.copilotUsageNanoAiu === "number"
              ? entry.attrs.copilotUsageNanoAiu : 0;
            totalOrphanNanoAiu += nano;
            const model = typeof entry?.attrs?.model === "string" ? entry.attrs.model : "unknown";
            const row = orphanByModel.get(model) ?? { calls: 0, nanoAiu: 0 };
            row.calls += 1;
            row.nanoAiu += nano;
            orphanByModel.set(model, row);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  console.log(`Orphan breakdown by kind:`);
  console.log(`  title-*.jsonl       : ${titleOrphans}`);
  console.log(`  runSubagent-*.jsonl : ${subagentOrphans}\n`);
  console.log(`Orphan llm_requests dropped: ${totalOrphanCalls}`);
  console.log(`Orphan AIC credits dropped : ${(totalOrphanNanoAiu / 1_000_000_000).toFixed(6)}\n`);
  console.log(`Orphan by model:`);
  for (const [m, v] of Array.from(orphanByModel.entries()).sort((a, b) => b[1].nanoAiu - a[1].nanoAiu)) {
    console.log(`  ${m.padEnd(40)} calls=${String(v.calls).padStart(4)}  aic=${(v.nanoAiu / 1e9).toFixed(6)}`);
  }

  console.log(`\nFirst 5 affected sessions:`);
  for (const r of reports.slice(0, 5)) {
    console.log(`\n  ${r.sessionDir}`);
    console.log(`    on disk    : ${r.filesOnDisk.length} child file(s)`);
    console.log(`    referenced : ${r.referenced.length} via child_session_ref`);
    console.log(`    ORPHANS    : ${r.orphans.length}`);
    for (const o of r.orphans.slice(0, 5)) console.log(`      - ${o}`);
    if (r.orphans.length > 5) console.log(`      ... ${r.orphans.length - 5} more`);
  }
}

audit();
