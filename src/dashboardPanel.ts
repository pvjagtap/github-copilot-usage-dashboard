/**
 * dashboardPanel.ts — Full dashboard webview for VS Code.
 * Ports the entire dashboard.py HTML template to TypeScript.
 * Includes: stats grid, live OTel, daily chart, model pie,
 * top tools, top projects, sessions table, model usage, subagent table.
 */

import * as vscode from "vscode";
import { DashboardData } from "./dashboardData";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  static onRefreshRateChange: ((intervalMs: number) => void) | undefined;
  static onManualRefresh: (() => void) | undefined;
  static onOpenFile: ((filePath: string) => void) | undefined;
  private panel: vscode.WebviewPanel;
  private disposed = false;

  static show(extensionUri: vscode.Uri, data: DashboardData): DashboardPanel {
    if (DashboardPanel.instance && !DashboardPanel.instance.disposed) {
      DashboardPanel.instance.panel.reveal();
      DashboardPanel.instance.update(data);
      return DashboardPanel.instance;
    }
    const inst = new DashboardPanel(extensionUri, data);
    DashboardPanel.instance = inst;
    return inst;
  }

  /** Update dashboard data only if the panel is already open — never creates or steals focus */
  static updateIfVisible(data: DashboardData): void {
    if (DashboardPanel.instance && !DashboardPanel.instance.disposed) {
      DashboardPanel.instance.update(data);
    }
  }

  private constructor(extensionUri: vscode.Uri, data: DashboardData) {
    this.panel = vscode.window.createWebviewPanel(
      "copilotUsageDashboard",
      "Copilot Usage Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      DashboardPanel.instance = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'refreshRate' && DashboardPanel.onRefreshRateChange) {
        DashboardPanel.onRefreshRateChange(msg.intervalMs);
      } else if (msg.type === 'manualRefresh' && DashboardPanel.onManualRefresh) {
        DashboardPanel.onManualRefresh();
      } else if (msg.type === 'openFile' && msg.path && DashboardPanel.onOpenFile) {
        DashboardPanel.onOpenFile(msg.path);
      }
    });
    this.panel.webview.html = this.buildHtml(data);
  }

  update(data: DashboardData): void {
    if (this.disposed) { return; }
    this.panel.webview.postMessage({ type: 'updateData', data });
  }

  private buildHtml(data: DashboardData): string {
    const jsonData = JSON.stringify(data);

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:;">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
:root {
  --bg: #0d1117; --card: #161b22; --border: #30363d;
  --fg: #e6edf3; --muted: #8b949e; --blue: #58a6ff;
  --green: #3fb950; --orange: #d29922; --red: #f85149;
  --purple: #bc8cff;
  --grid: #30363d33;
  --chart-bar1: rgba(88,166,255,0.82); --chart-bar2: rgba(188,140,255,0.82);
  --peak-bar: rgba(248,81,73,0.75); --normal-bar: rgba(210,153,34,0.75);
  --pill-blue-bg: #0d1d33; --pill-blue-border: #1f3a5f;
  --pill-green-bg: #0d2818; --pill-green-border: #1a4731;
  --pill-orange-bg: #2d1f0d; --pill-orange-border: #4a3319;
  --model-opus-bg: #1a1a2e; --model-opus-fg: #c084fc; --model-opus-border: #7c3aed44;
  --model-sonnet-bg: #1a2332; --model-sonnet-fg: #93c5fd; --model-sonnet-border: #3b82f644;
  --model-haiku-bg: #1a2e2e; --model-haiku-fg: #5eead4; --model-haiku-border: #14b8a644;
  --model-gpt-bg: #1a2e1a; --model-gpt-fg: #86efac; --model-gpt-border: #22c55e44;
  --model-gemini-bg: #2e2e1a; --model-gemini-fg: #fde68a; --model-gemini-border: #f59e0b44;
  --mult-high-bg: #2d1f0d; --mult-high-border: #4a331944;
  --link-bg: rgba(88,166,255,0.08); --link-border: rgba(88,166,255,0.35); --link-hover-bg: rgba(88,166,255,0.14);
}
body.vscode-light {
  --bg: #f5f0e8; --card: #ffffff; --border: #e0d8cc;
  --fg: #2d2a26; --muted: #6b6560; --blue: #2563eb;
  --green: #16a34a; --orange: #b45309; --red: #dc2626;
  --purple: #7c3aed;
  --grid: #d8d0c433;
  --chart-bar1: rgba(37,99,235,0.72); --chart-bar2: rgba(124,58,237,0.72);
  --peak-bar: rgba(220,38,38,0.65); --normal-bar: rgba(180,83,9,0.65);
  --pill-blue-bg: #eff6ff; --pill-blue-border: #bfdbfe;
  --pill-green-bg: #f0fdf4; --pill-green-border: #bbf7d0;
  --pill-orange-bg: #fffbeb; --pill-orange-border: #fde68a;
  --model-opus-bg: #faf5ff; --model-opus-fg: #7c3aed; --model-opus-border: #c4b5fd;
  --model-sonnet-bg: #eff6ff; --model-sonnet-fg: #2563eb; --model-sonnet-border: #93c5fd;
  --model-haiku-bg: #f0fdfa; --model-haiku-fg: #0f766e; --model-haiku-border: #99f6e4;
  --model-gpt-bg: #f0fdf4; --model-gpt-fg: #16a34a; --model-gpt-border: #86efac;
  --model-gemini-bg: #fefce8; --model-gemini-fg: #a16207; --model-gemini-border: #fde68a;
  --mult-high-bg: #fffbeb; --mult-high-border: #fde68a;
  --link-bg: rgba(37,99,235,0.06); --link-border: rgba(37,99,235,0.3); --link-hover-bg: rgba(37,99,235,0.12);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; padding: 20px; }
h1 { font-size: 22px; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; }
.subtitle { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
.filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
.filter-bar label { font-size: 12px; color: var(--fg); cursor: pointer; }
.filter-bar input[type="checkbox"] { margin-right: 3px; }
.btn-sm { font-size: 11px; padding: 2px 8px; background: var(--card); color: var(--blue); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.btn-sm:hover { background: var(--border); }
.range-btns { display: flex; gap: 4px; margin-left: 12px; }
.range-btn { font-size: 11px; padding: 3px 10px; background: var(--card); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.range-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
.refresh-btns { display: flex; gap: 4px; margin-left: 12px; align-items: center; }
.refresh-label { font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-right: 2px; }
.btn-refresh { font-size: 11px; padding: 3px 10px; background: var(--card); color: var(--green); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; margin-left: 6px; }
.btn-refresh:hover { background: var(--border); }
.btn-refresh.spinning { animation: spin 0.8s linear; pointer-events: none; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.stats-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; min-width: 130px; flex: 1; }
.stat-card .label { font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; margin-bottom: 2px; }
.stat-card .value { font-size: 24px; font-weight: 700; }
.stat-card .sub { font-size: 10px; color: var(--muted); margin-top: 1px; }
.cached { color: var(--green) !important; }
.orange { color: var(--orange) !important; }
.table-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 8px; }
.section-subtitle { font-size: 12px; color: var(--green); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 10px; text-transform: uppercase; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--border); }
td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.model-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 500; display: inline-block; }
.model-opus { background: var(--model-opus-bg); color: var(--model-opus-fg); border: 1px solid var(--model-opus-border); }
.model-sonnet { background: var(--model-sonnet-bg); color: var(--model-sonnet-fg); border: 1px solid var(--model-sonnet-border); }
.model-haiku { background: var(--model-haiku-bg); color: var(--model-haiku-fg); border: 1px solid var(--model-haiku-border); }
.model-gpt { background: var(--model-gpt-bg); color: var(--model-gpt-fg); border: 1px solid var(--model-gpt-border); }
.model-gemini { background: var(--model-gemini-bg); color: var(--model-gemini-fg); border: 1px solid var(--model-gemini-border); }
.model-default { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
.charts-grid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 16px; }
@media (min-width: 900px) { .charts-grid { grid-template-columns: 1fr 1fr; } }
.chart-wide { grid-column: 1 / -1; }
.chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.chart-card h3 { font-size: 13px; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.chart-card canvas#modelChart { max-height: 500px; }
.tz-toggle { display: inline-flex; gap: 0; margin-left: auto; }
.tz-btn { font-size: 11px; padding: 3px 10px; background: var(--card); color: var(--muted); border: 1px solid var(--border); cursor: pointer; }
.tz-btn:first-child { border-radius: 4px 0 0 4px; }
.tz-btn:last-child { border-radius: 0 4px 4px 0; }
.tz-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
.empty-panel { color: var(--muted); font-size: 13px; padding: 20px; text-align: center; }
.note { color: var(--muted); font-size: 11px; line-height: 1.5; margin-bottom: 8px; }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--card); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; display: inline-block; margin: 1px; }
.pill-blue { background: var(--pill-blue-bg); color: var(--blue); border-color: var(--pill-blue-border); }
.pill-green { background: var(--pill-green-bg); color: var(--green); border-color: var(--pill-green-border); }
.pill-orange { background: var(--pill-orange-bg); color: var(--orange); border-color: var(--pill-orange-border); }
.file-link { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; text-decoration: none; border: 1px solid var(--link-border); color: var(--blue); background: var(--link-bg); cursor: pointer; }
.file-link:hover { border-color: var(--blue); background: var(--link-hover-bg); }
.file-links { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.mult-badge { font-size: 9px; padding: 0 4px; border-radius: 3px; margin-left: 4px; }
.mult-1 { background: transparent; color: var(--blue); }
.mult-low { background: transparent; color: var(--green); }
.mult-high { background: var(--mult-high-bg); color: var(--orange); border: 1px solid var(--mult-high-border); }
.summary-cell .title { font-weight: 600; font-size: 12px; }
.summary-cell .preview { color: var(--muted); font-size: 11px; margin-top: 2px; }
.summary-cell .tags { margin-top: 3px; }
.sessions-scroll { max-height: 600px; overflow-y: auto; }
.sessions-scroll::-webkit-scrollbar { width: 6px; }
.sessions-scroll::-webkit-scrollbar-track { background: var(--bg); }
.sessions-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.sessions-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted); }
</style>
</head>
<body>
<h1>
  <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>
  Copilot Usage Dashboard
</h1>
<div class="subtitle" id="subtitle"></div>
<div class="filter-bar" id="filter-bar"></div>
<div class="stats-row" id="stats-row"></div>
<div id="live-otel-section"></div>
<div class="charts-grid" id="charts-grid">
  <div class="chart-card"><h3>By Model</h3><canvas id="modelChart"></canvas></div>
  <div class="chart-card"><h3>Top Projects by Tokens</h3><canvas id="projectChart"></canvas></div>
  <div class="chart-card"><h3>Top Tools</h3><canvas id="toolChart"></canvas></div>
  <div id="subagent-section"></div>
</div>
<div id="sessions-section"></div>
<div id="model-section"></div>
<div class="chart-card" style="margin-bottom:16px"><h3>Daily Token Usage</h3><canvas id="dailyChart"></canvas></div>
<div class="chart-card" style="margin-bottom:16px"><div style="display:flex;align-items:center"><h3 style="flex:1" id="hourlyTitle">Average Hourly Distribution</h3><div class="tz-toggle"><button class="tz-btn" onclick="setTz(this,'local')">Local</button><button class="tz-btn active" onclick="setTz(this,'utc')">UTC</button></div></div><canvas id="hourlyChart"></canvas></div>
<div class="note" style="margin-top:16px;text-align:center;">
  Token counts come from VS Code chatSessions files. Live OTel adds request, prompt, output, and cache-read token visibility.
</div>

<script>
let DATA = ${jsonData};
const MODEL_COLORS = ['#58a6ff','#3fb950','#bc8cff','#d29922','#f85149','#79c0ff','#f778ba','#a5d6ff'];
const RANGE_LABELS = {'7d':'Last 7 Days','30d':'Last 30 Days','90d':'Last 90 Days','tw':'This Week','tm':'This Month','pm':'Prev Month','all':'All Time'};
const KNOWN_MULT = {'claude-opus':3,'claude-sonnet':1,'claude-haiku':0.25,'gpt-5':1,'gpt-4.1':1,'gpt-4o-mini':0.25,'gpt-4.1-mini':0.25,'o3':3,'o3-mini':0.25,'o4-mini':0.25,'gemini-2.5-pro':3,'gemini-2.0-flash':0.25};

const vscode = acquireVsCodeApi();
const _saved = vscode.getState() || {};
let selectedRange = _saved.selectedRange || '30d';
let selectedModels = _saved.selectedModels ? new Set(_saved.selectedModels.filter(m => DATA.allModels.includes(m))) : new Set(DATA.allModels);
let selectedRefresh = typeof _saved.selectedRefresh === 'number' ? _saved.selectedRefresh : 120;
let selectedTz = _saved.selectedTz || 'utc';
let charts = {};
function _saveState() { vscode.setState({ selectedRange, selectedRefresh, selectedModels: Array.from(selectedModels), selectedTz }); }

function fmt(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return n.toLocaleString();
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function tc(v) { return getComputedStyle(document.documentElement).getPropertyValue('--'+v).trim(); }
function mc(m) {
  const l = m.toLowerCase();
  if (l.includes('opus')) return 'model-opus';
  if (l.includes('sonnet')) return 'model-sonnet';
  if (l.includes('haiku')) return 'model-haiku';
  if (l.includes('gpt')) return 'model-gpt';
  if (l.includes('gemini')) return 'model-gemini';
  return 'model-default';
}
function getMult(model, sm) {
  if (sm && sm > 0) return sm;
  const l = model.toLowerCase();
  for (const [k,v] of Object.entries(KNOWN_MULT)) { if (l.includes(k)) return v; }
  return 1;
}
function mbadge(m) {
  if (m >= 2) return '<span class="mult-badge mult-high">'+m+'x</span>';
  if (m < 1) return '<span class="mult-badge mult-low">'+m+'x</span>';
  return '<span class="mult-badge mult-1">'+m+'x</span>';
}
function getRangeBounds(r) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0,10);
  if (r === 'all') return { start: '', end: '' };
  if (r === '7d') { const d=new Date(now); d.setDate(d.getDate()-7); return {start:iso(d),end:''}; }
  if (r === '30d') { const d=new Date(now); d.setDate(d.getDate()-30); return {start:iso(d),end:''}; }
  if (r === '90d') { const d=new Date(now); d.setDate(d.getDate()-90); return {start:iso(d),end:''}; }
  if (r === 'tw') { const d=new Date(now); const day=d.getDay(); const diff=day===0?6:day-1; d.setDate(d.getDate()-diff); return {start:iso(d),end:''}; }
  if (r === 'tm') { return {start:iso(new Date(now.getFullYear(),now.getMonth(),1)),end:''}; }
  if (r === 'pm') { const s=new Date(now.getFullYear(),now.getMonth()-1,1); const e=new Date(now.getFullYear(),now.getMonth(),0); return {start:iso(s),end:iso(e)}; }
  return {start:'',end:''};
}
function rangeIncludesToday(r) { return r !== 'pm'; }

function buildFilterBar() {
  let h = '<span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600;">Models</span>';
  DATA.allModels.forEach(m => {
    const chk = selectedModels.has(m) ? ' checked' : '';
    h += ' <label><input type="checkbox" data-model="'+esc(m)+'"'+chk+' onchange="toggleModel(this)"> <span class="model-tag '+mc(m)+'">'+esc(m)+'</span></label>';
  });
  h += ' <button class="btn-sm" onclick="pickAll()">All</button><button class="btn-sm" onclick="pickNone()">None</button>';
  h += '<div class="range-btns">';
  ['7d','30d','90d','tw','tm','pm','all'].forEach(r => { h += '<button class="range-btn'+(r===selectedRange?' active':'')+'" onclick="setRange(this,\\''+r+'\\')">'+(r==='tw'?'This Week':r==='tm'?'This Month':r==='pm'?'Prev Month':r)+'</button>'; });
  h += '</div>';  h += '<div class="refresh-btns"><span class="refresh-label">Refresh</span>';
  [{l:'30s',v:30},{l:'1m',v:60},{l:'2m',v:120},{l:'5m',v:300},{l:'Off',v:0}].forEach(o => {
    h += '<button class="range-btn'+(o.v===selectedRefresh?' active':'')+'" data-refresh-val="'+o.v+'" onclick="setRefresh(this,'+o.v+')">'+o.l+'</button>';
  });
  h += '</div>';
  h += '<button class="btn-refresh" onclick="manualRefresh(this)" title="Refresh now">&#x21bb;</button>';
  document.getElementById('filter-bar').innerHTML = h;
}
function toggleModel(cb) { if(cb.checked) selectedModels.add(cb.dataset.model); else selectedModels.delete(cb.dataset.model); _saveState(); render(); }
function pickAll() { DATA.allModels.forEach(m=>selectedModels.add(m)); document.querySelectorAll('#filter-bar input').forEach(c=>c.checked=true); _saveState(); render(); }
function pickNone() { selectedModels.clear(); document.querySelectorAll('#filter-bar input').forEach(c=>c.checked=false); _saveState(); render(); }
function setRange(btn, r) {
  selectedRange=r;
  btn.closest('.range-btns').querySelectorAll('.range-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _saveState();
  // Auto-refresh awareness: disable when range doesn't include today
  if (!rangeIncludesToday(r) && selectedRefresh > 0) {
    selectedRefresh = 0;
    _saveState();
    vscode.postMessage({type:'refreshRate',intervalMs:0});
    updateRefreshButtons();
  } else if (rangeIncludesToday(r) && selectedRefresh === 0) {
    selectedRefresh = 120;
    _saveState();
    vscode.postMessage({type:'refreshRate',intervalMs:120000});
    updateRefreshButtons();
  }
  render();
}
function updateRefreshButtons() {
  document.querySelectorAll('.refresh-btns .range-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.refreshVal||'-1') === selectedRefresh);
  });
}
function setTz(btn, tz) { selectedTz=tz; btn.closest('.tz-toggle').querySelectorAll('.tz-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); _saveState(); render(); }
function setRefresh(btn, secs) { selectedRefresh=secs; btn.closest('.refresh-btns').querySelectorAll('.range-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); _saveState(); vscode.postMessage({type:'refreshRate',intervalMs:secs*1000}); }
function manualRefresh(btn) { vscode.postMessage({type:'manualRefresh'}); }

function render() {
  const bounds = getRangeBounds(selectedRange);
  const sessions = DATA.sessionsAll.filter(s => selectedModels.has(s.model) && (!bounds.start || s.lastDate >= bounds.start) && (!bounds.end || s.lastDate <= bounds.end));
  const sids = new Set(sessions.map(s=>s.sessionId));
  const daily = DATA.dailyByModel.filter(d => selectedModels.has(d.model) && (!bounds.start || d.day >= bounds.start) && (!bounds.end || d.day <= bounds.end));
  const tools = DATA.toolsAll.filter(t => sids.has(t.sessionId));
  const subs = DATA.subagentsAll.filter(s => sids.has(s.sessionId));
  const turns = DATA.turnsAll.filter(t => selectedModels.has(t.model) && (!bounds.start || t.timestamp.slice(0,10) >= bounds.start) && (!bounds.end || t.timestamp.slice(0,10) <= bounds.end));

  const t = {
    sessions: sessions.length,
    turns: sessions.reduce((s,x)=>s+x.turns,0),
    prompt: sessions.reduce((s,x)=>s+x.prompt,0),
    output: sessions.reduce((s,x)=>s+x.output,0),
    tools: tools.reduce((s,x)=>s+x.count,0),
    subs: subs.reduce((s,x)=>s+x.count,0),
    premium: sessions.reduce((s,x)=>s+getMult(x.modelName,x.multiplier)*x.turns,0),
  };

  const rl = RANGE_LABELS[selectedRange] || selectedRange;
  const refreshStatus = selectedRefresh > 0 ? '' : ' (auto-refresh off)';
  document.getElementById('subtitle').textContent = 'Updated: '+DATA.generatedAt+' — '+rl+refreshStatus;
  document.getElementById('stats-row').innerHTML = [
    {l:'Sessions',v:t.sessions,s:rl.toLowerCase()},
    {l:'Turns',v:t.turns,s:rl},
    {l:'Prompt Tokens',v:fmt(t.prompt),s:'input tokens'},
    {l:'Output Tokens',v:fmt(t.output),s:'generated tokens'},
    {l:'Tool Calls',v:fmt(t.tools),s:'all tool invocations'},
    {l:'Subagent Calls',v:t.subs,s:'runSubagent only'},
    {l:'Est. Premium',v:Math.round(t.premium),s:'multiplier estimate',c:'orange'},
    {l:'Mirrors',v:DATA.scanStats.mirroredSessions,s:DATA.scanStats.mirrorCopiesPruned+' pruned'},
    {l:'Transcripts',v:DATA.scanStats.transcriptsFound,s:DATA.scanStats.promptPreviews+' with previews'},
  ].map(c=>'<div class="stat-card"><div class="label">'+c.l+'</div><div class="value'+(c.c?' '+c.c:'')+'">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('');

  renderOtel(DATA.liveOtel);
  renderDaily(daily);
  renderModelPie(sessions);
  renderProjectBar(sessions);
  renderToolBar(tools);
  renderSessions(sessions, subs);
  renderModelTable(sessions);
  renderSubagents(subs);
  renderHourly(turns);
}

function renderOtel(live) {
  const el = document.getElementById('live-otel-section');
  if (!live || !live.requests) {
    el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">Live OpenTelemetry</div><div class="section-subtitle">Waiting for Copilot telemetry</div></div><div class="empty-panel">The OTel receiver is active. Send a Copilot chat message and data will appear here.</div></div>';
    return;
  }
  const ls = live.lastSeen ? live.lastSeen.slice(0,19).replace('T',' ') : '';
  const csub = live.metricCached ? 'using metric deltas' : 'trace fallback only';
  let rows = '';
  (live.byModel||[]).forEach(m => {
    rows += '<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span></td><td class="num">'+m.requests+'</td><td class="num">'+fmt(m.prompt)+'</td><td class="num">'+fmt(m.completion)+'</td><td class="num">'+fmt(m.traceCached)+'</td><td class="num">'+fmt(m.metricCached)+'</td><td class="num cached">'+fmt(m.cached)+'</td></tr>';
  });
  el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">Live OpenTelemetry</div><div class="section-subtitle">Last event '+esc(ls)+'</div></div>'
    +'<div class="note">Live OTLP export. Cached tokens prefer cumulative metric deltas when available.</div>'
    +'<div class="stats-row">'
    +['OTel Requests:'+live.requests+':last event '+esc(ls),'Live Prompt:'+fmt(live.prompt)+':from traces','Live Output:'+fmt(live.completion)+':from traces','Live Cached:'+fmt(live.cached)+':'+csub,'Trace Cache:'+fmt(live.traceCached)+':cache_read','Metric Cache:'+fmt(live.metricCached)+':token.usage']
      .map((s,i)=>{const p=s.split(':');return '<div class="stat-card"><div class="label">'+p[0]+'</div><div class="value'+(i===3?' cached':'')+'">'+p[1]+'</div><div class="sub">'+p[2]+'</div></div>';}).join('')
    +'</div>'
    +'<div class="section-title" style="margin-top:8px">Live OTel by Model</div>'
    +'<table><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Trace Cache</th><th class="num">Metric Cache</th><th class="num">Effective Cache</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function dc(k) { if(charts[k]) { charts[k].destroy(); charts[k]=null; } }

function renderDaily(daily) {
  dc('daily');
  const days = [...new Set(daily.map(d=>d.day))].sort();
  const pMap={}, oMap={};
  days.forEach(d=>{pMap[d]=0;oMap[d]=0;});
  daily.forEach(d=>{pMap[d.day]+=d.prompt;oMap[d.day]+=d.output;});
  charts.daily = new Chart(document.getElementById('dailyChart'), {
    type:'bar', data:{labels:days, datasets:[
      {label:'Prompt',data:days.map(d=>pMap[d]),backgroundColor:tc('chart-bar1'),stack:'tokens',yAxisID:'y'},
      {label:'Output',data:days.map(d=>oMap[d]),backgroundColor:tc('chart-bar2'),stack:'tokens',yAxisID:'y'}
    ]},
    options:{responsive:true, plugins:{legend:{labels:{color:tc('muted')}}}, scales:{
      x:{stacked:true,ticks:{color:tc('muted'),maxRotation:45},grid:{color:tc('grid')}},
      y:{position:'left',stacked:true,ticks:{color:tc('blue'),callback:v=>fmt(v)},grid:{color:tc('grid')},title:{display:true,text:'Tokens',color:tc('blue')}}
    }}
  });
}

function renderModelPie(sessions) {
  dc('model');
  const m={};
  sessions.forEach(s=>{m[s.model]=(m[s.model]||0)+s.prompt+s.output;});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  charts.model = new Chart(document.getElementById('modelChart'), {
    type:'doughnut', data:{labels:sorted.map(e=>e[0]),datasets:[{data:sorted.map(e=>e[1]),backgroundColor:MODEL_COLORS.slice(0,sorted.length)}]},
    options:{responsive:true,maintainAspectRatio:true,aspectRatio:1.3,plugins:{legend:{position:'bottom',labels:{color:tc('muted')}}}}
  });
}

function renderProjectBar(sessions) {
  dc('project');
  const pm={},om={};
  sessions.forEach(s=>{pm[s.project]=(pm[s.project]||0)+s.prompt;om[s.project]=(om[s.project]||0)+s.output;});
  const sorted=Object.entries(pm).map(([k,v])=>[k,v+(om[k]||0)]).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const labels=sorted.map(e=>e[0]);
  charts.project = new Chart(document.getElementById('projectChart'), {
    type:'bar', data:{labels, datasets:[
      {label:'Prompt',data:labels.map(l=>pm[l]||0),backgroundColor:tc('chart-bar1')},
      {label:'Output',data:labels.map(l=>om[l]||0),backgroundColor:tc('chart-bar2')}
    ]},
    options:{indexAxis:'y',responsive:true,plugins:{legend:{labels:{color:tc('muted')}}},scales:{
      x:{stacked:true,ticks:{color:tc('muted'),callback:v=>fmt(v)},grid:{color:tc('grid')}},
      y:{stacked:true,ticks:{color:tc('muted'),font:{size:10}},grid:{color:tc('grid')}}
    }}
  });
}

function renderToolBar(tools) {
  dc('tool');
  const m={};
  tools.forEach(t=>{m[t.toolName]=(m[t.toolName]||0)+t.count;});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,10);
  charts.tool = new Chart(document.getElementById('toolChart'), {
    type:'bar', data:{labels:sorted.map(e=>e[0]),datasets:[{label:'Calls',data:sorted.map(e=>e[1]),backgroundColor:tc('chart-bar1')}]},
    options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}},scales:{
      x:{ticks:{color:tc('muted')},grid:{color:tc('grid')}},
      y:{ticks:{color:tc('muted'),font:{size:10}},grid:{color:tc('grid')}}
    }}
  });
}

function renderSessions(sessions, subs) {
  const el = document.getElementById('sessions-section');
  if (!sessions.length) { el.innerHTML=''; return; }
  const sm={};
  subs.forEach(s=>{if(!sm[s.sessionId])sm[s.sessionId]={};sm[s.sessionId][s.agentName]=(sm[s.sessionId][s.agentName]||0)+s.count;});
  let rows='';
  sessions.forEach(s=>{
    const mult=getMult(s.modelName,s.multiplier);
    const sd=sm[s.sessionId]?Object.entries(sm[s.sessionId]).map(([a,c])=>'<span class="pill">'+esc(a)+' x'+c+'</span>').join(' '):'';
    const ap=s.agentId?'<span class="pill pill-green">'+esc(s.agentId)+'</span>':'';
    const bp=s.account?'<span class="pill pill-blue">'+esc(s.account)+'</span>':'';
    const sum='<div class="summary-cell">'+(s.title?'<div class="title">'+esc(s.title)+'</div>':'')+(s.promptPreview?'<div class="preview">'+esc(s.promptPreview)+'</div>':'')+'<div class="tags">'+ap+' '+bp+'</div></div>';
    const fl=(s.sourcePaths||[]).map((p,i)=>'<span class="file-link" data-path="'+esc(p)+'" title="'+esc(p)+'">log '+(i+1)+'</span>').join('')
      +(s.transcriptPaths||[]).map((p,i)=>'<span class="file-link" data-path="'+esc(p)+'" title="'+esc(p)+'">transcript '+(i+1)+'</span>').join('');
    const flDiv=fl?'<div class="file-links">'+fl+'</div>':'';
    rows+='<tr><td style="font-family:monospace;font-size:11px">'+esc(s.sessionShort)+'...</td><td>'+esc(s.project)+'</td><td>'+sum+'</td><td style="font-size:11px">'+esc(s.last)+'</td><td class="num">'+s.durationMin+'m</td><td><span class="model-tag '+mc(s.modelName)+'">'+esc(s.modelName)+'</span>'+mbadge(mult)+'</td><td class="num">'+s.turns+'</td><td class="num">'+fmt(s.prompt)+'</td><td class="num">'+fmt(s.output)+'</td><td class="num">'+fmt(s.toolCalls)+'</td><td class="num">'+(s.subagents||'')+(sd?' '+sd:'')+'</td><td>'+flDiv+'</td></tr>';
  });
  el.innerHTML='<div class="table-card"><div class="section-title">All Sessions &mdash; '+sessions.length+' shown</div><div class="sessions-scroll"><table><thead><tr><th>Session</th><th>Project</th><th>Summary</th><th>Last Active</th><th class="num">Duration</th><th>Model</th><th class="num">Turns</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Tools</th><th class="num">Subagents</th><th>Files</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  el.querySelectorAll('.file-link[data-path]').forEach(link => {
    link.addEventListener('click', () => { vscode.postMessage({type:'openFile',path:link.dataset.path}); });
  });
}

function renderModelTable(sessions) {
  const el=document.getElementById('model-section');
  const m={};
  sessions.forEach(s=>{
    const k=s.modelName;
    if(!m[k])m[k]={model:k,mult:getMult(k,s.multiplier),sessions:new Set(),turns:0,prompt:0,output:0,tools:0,subs:0};
    m[k].sessions.add(s.sessionId);m[k].turns+=s.turns;m[k].prompt+=s.prompt;m[k].output+=s.output;m[k].tools+=s.toolCalls;m[k].subs+=s.subagents;
  });
  const sorted=Object.values(m).sort((a,b)=>(b.prompt+b.output)-(a.prompt+a.output));
  let rows='';
  sorted.forEach(m=>{
    rows+='<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span></td><td class="num">'+m.mult+'x</td><td class="num">'+m.sessions.size+'</td><td class="num">'+m.turns+'</td><td class="num">'+fmt(m.prompt)+'</td><td class="num">'+fmt(m.output)+'</td><td class="num">'+fmt(m.tools)+'</td><td class="num">'+m.subs+'</td><td class="num orange">'+Math.round(m.mult*m.turns)+'</td></tr>';
  });
  el.innerHTML='<div class="table-card"><div class="section-title">Usage by Model</div><table><thead><tr><th>Model</th><th class="num">Multiplier</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Tools</th><th class="num">Subagents</th><th class="num">Est. Premium</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function renderSubagents(subs) {
  const el=document.getElementById('subagent-section');
  if(!subs.length){el.innerHTML='';return;}
  const m={};
  subs.forEach(s=>{m[s.agentName]=(m[s.agentName]||0)+s.count;});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  let rows='';
  sorted.forEach(([n,c])=>{rows+='<tr><td><span class="pill pill-orange">'+esc(n)+'</span></td><td class="num">'+c+'</td></tr>';});
  el.innerHTML='<div class="chart-card" style="height:100%"><h3>Subagent Usage</h3><table><thead><tr><th>Subagent</th><th class="num">Invocations</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function renderHourly(turns) {
  dc('hourly');
  if (!turns.length) { document.getElementById('hourlyTitle').textContent = 'Average Hourly Distribution'; return; }
  // Compute hourly buckets
  const tzOff = selectedTz === 'local' ? new Date().getTimezoneOffset() : 0;
  const tzName = selectedTz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const hourTurns = new Array(24).fill(0);
  const hourOutput = new Array(24).fill(0);
  const daysSet = new Set();
  turns.forEach(t => {
    const d = new Date(t.timestamp);
    if (isNaN(d.getTime())) return;
    // Apply timezone
    const adjusted = new Date(d.getTime() - tzOff * 60000);
    const h = adjusted.getUTCHours();
    hourTurns[h]++;
    hourOutput[h] += t.output;
    daysSet.add(adjusted.toISOString().slice(0,10));
  });
  const numDays = Math.max(daysSet.size, 1);
  const avgTurns = hourTurns.map(v => Math.round(v / numDays * 10) / 10);
  const avgOutput = hourOutput.map(v => Math.round(v / numDays));

  // Peak hours: Mon-Fri 05:00-11:00 PT = 12:00-17:00 UTC
  const peakUtcStart = 12, peakUtcEnd = 17;
  function isPeakHour(h) {
    // Convert display hour back to UTC (tzOff is in minutes, positive=west)
    const utcH = selectedTz === 'local' ? (h + Math.floor(tzOff / 60) + 24) % 24 : h;
    return utcH >= peakUtcStart && utcH <= peakUtcEnd;
  }
  const barColors = avgTurns.map((_,h) => isPeakHour(h) ? tc('peak-bar') : tc('normal-bar'));

  const labels = Array.from({length:24}, (_,h) => {
    const lbl = String(h).padStart(2,'0')+':00';
    return isPeakHour(h) ? '\u26A1 '+lbl : lbl;
  });

  document.getElementById('hourlyTitle').textContent = 'Average Hourly Distribution — '+RANGE_LABELS[selectedRange]+' ('+numDays+' days) — '+tzName;
  // Update tz toggle state
  document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b.textContent.trim().toLowerCase() === selectedTz));

  charts.hourly = new Chart(document.getElementById('hourlyChart'), {
    type:'bar', data:{labels, datasets:[
      {label:'Avg Turns',data:avgTurns,backgroundColor:barColors,yAxisID:'y',order:2},
      {label:'Avg Output Tokens',data:avgOutput,type:'line',borderColor:tc('purple'),backgroundColor:tc('chart-bar2'),pointBackgroundColor:tc('purple'),pointRadius:3,yAxisID:'y1',tension:0.3,order:1}
    ]},
    options:{responsive:true,plugins:{
      legend:{labels:{color:tc('muted')}},
      tooltip:{callbacks:{afterLabel:function(ctx){if(ctx.datasetIndex===0 && isPeakHour(ctx.dataIndex))return 'Peak — Anthropic US hours';return '';}}}
    },scales:{
      x:{ticks:{color:tc('muted'),maxRotation:45},grid:{color:tc('grid')}},
      y:{position:'left',ticks:{color:tc('orange')},grid:{color:tc('grid')},title:{display:true,text:'Avg Turns',color:tc('orange')}},
      y1:{position:'right',ticks:{color:tc('purple'),callback:v=>fmt(v)},grid:{drawOnChartArea:false},title:{display:true,text:'Avg Output Tokens',color:tc('purple')}}
    }}
  });
}

buildFilterBar();
render();

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'updateData' && msg.data) {
    DATA = msg.data;
    // Re-check model set: keep selected, add new models
    const newModels = new Set(DATA.allModels);
    selectedModels.forEach(m => { if (!newModels.has(m)) selectedModels.delete(m); });
    DATA.allModels.forEach(m => { if (!selectedModels.has(m)) selectedModels.add(m); });
    buildFilterBar();
    render();
  }
});
<\/script>
</body>
</html>`;
  }
}
