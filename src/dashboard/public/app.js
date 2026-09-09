/* =========================================================================
 * OpenCode Go Router — Control Room
 * Dashboard client. Vanilla JS, no framework.
 * ========================================================================= */
'use strict';

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const escapeHtml = (v) => String(v ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const fmtNumber = (v) => Number(v || 0).toLocaleString('en-US');
const fmtCurrency = (v) => `$${Number(v || 0).toFixed(4)}`;
const fmtTokens = (v) => {
  const n = Number(v || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return n.toLocaleString('en-US');
};
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const fmtDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
};
const fmtCooldown = (ms) => {
  if (!ms) return 'Ready';
  const remaining = ms - Date.now();
  if (remaining <= 0) return 'Ready';
  const m = Math.ceil(remaining / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
const rAFThrottle = (fn) => {
  let pending = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const toastStack = $('#toast-stack');
function toast(message, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const api = {
  async req(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  status() { return this.req('/api/status'); },
  keys() { return this.req('/api/keys'); },
  strategies() { return this.req('/api/strategies'); },
  currentStrategy() { return this.req('/api/strategy'); },
  setStrategy(s) { return this.req('/api/strategy', { method: 'PUT', body: { strategy: s } }); },
  addKey(payload) { return this.req('/api/keys', { method: 'POST', body: payload }); },
  updateKey(id, payload) { return this.req(`/api/keys/${id}`, { method: 'PUT', body: payload }); },
  replaceKey(id, key) { return this.req(`/api/keys/${id}/key`, { method: 'PUT', body: { key } }); },
  toggleKey(id, enabled) { return this.req(`/api/keys/${id}/toggle`, { method: 'PUT', body: { enabled } }); },
  reorderKeys(order) { return this.req('/api/keys/reorder', { method: 'PUT', body: { order } }); },
  resetCooldown(id) { return this.req(`/api/keys/${id}/reset-cooldown`, { method: 'POST' }); },
  restKey(id) { return this.req(`/api/keys/${id}/rest`, { method: 'POST' }); },
  resetBreaker(id) { return this.req(`/api/keys/${id}/reset-breaker`, { method: 'POST' }); },
  resetStats(id) { return this.req(`/api/keys/${id}/reset-stats`, { method: 'POST' }); },
  clearSessions() { return this.req('/api/sessions/clear', { method: 'POST' }); },
  failoverTuning() { return this.req('/api/failover-tuning'); },
  setFailoverTuning(payload) { return this.req('/api/failover-tuning', { method: 'PUT', body: payload }); },
  removeKey(id) { return this.req(`/api/keys/${id}`, { method: 'DELETE' }); },
  config() { return this.req('/api/config'); },
  setConfig(payload) { return this.req('/api/config', { method: 'PUT', body: payload }); },
  models() { return this.req('/api/models'); },
  visibleModels() { return this.req('/api/visible-models'); },
  zenProviderModels(provider) {
    const q = encodeURIComponent(provider || 'multi-auth-zen')
    return this.req(`/api/zen-provider-models?provider=${q}`)
  },
  setVisibleModels(payload) { return this.req('/api/visible-models', { method: 'PUT', body: payload }); },
  notifications() { return this.req('/api/notifications'); },
  testKey(id) { return this.req(`/api/keys/${id}/test`, { method: 'POST' }); },
  recentLogs() { return this.req('/api/logs'); },
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  currentPage: 'overview',
  strategies: [],
  activeStrategy: '',
  keys: [],
  summary: null,
  recentLogs: [],          // ring buffer
  archivedLogs: [],        // up to 10000 older entries
  expandedLogId: null,
  logFilter: { search: '', level: '', provider: '' },
  paused: false,
  pausedBuffer: [],
  logById: new Map(),      // id -> log entry, for finding expanded row
  visibleModels: null,     // string[] or null (null = all)
  zenProviderName: 'multi-auth-zen', // opencode.json provider name for drift detection
  failoverTuning: null,   // last fetched GET /api/failover-tuning (null = not loaded yet)
  zenDriftAnnounced: null, // last drift signature announced via toast (per session)
  zenDriftTimer: null,      // setTimeout handle for 12h re-check
};

// ---------------------------------------------------------------------------
// Event bus — used for live updates from WebSocket
// ---------------------------------------------------------------------------

const bus = new EventTarget();
const emit = (event, detail) => bus.dispatchEvent(new CustomEvent(event, { detail }));
const on = (event, handler) => bus.addEventListener(event, handler);

// ---------------------------------------------------------------------------
// Routing (page switching)
// ---------------------------------------------------------------------------

function setPage(page) {
  if (state.currentPage === 'models' && page !== 'models') {
    if (state.zenDriftTimer) {
      clearTimeout(state.zenDriftTimer);
      state.zenDriftTimer = null;
    }
  }
  state.currentPage = page;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $$('.page').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  if (page === 'logs') ensureLogRender();
  if (page === 'overview') renderOverview();
  if (page === 'routing') renderRouting();
  if (page === 'accounts') renderAccounts();
  if (page === 'tokens') renderTokens();
  if (page === 'models') renderModels();
  if (page === 'settings') renderSettings();
}

function initRouting() {
  $$('.nav-item').forEach((el) => {
    el.addEventListener('click', () => setPage(el.dataset.page));
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  initRouting();
  initModal();
  initTokensPage();
  initLogsToolbar();
  initSearch();
  initBreakStickiness();
  connectWebSocket();
  await refreshAll();
  await backfillLogs();
  // Re-render periodically for KPIs that come from the snapshot endpoint
  setInterval(refreshSnapshot, 5000);
  setInterval(refreshKeys, 10000);
  // Re-render accounts every 3s so the sparkline ticks even when no requests come in
  setInterval(() => {
    if (state.currentPage === 'accounts') renderAccounts();
    if (state.currentPage === 'overview') {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const k of Object.keys(chartState.series)) {
        chartState.series[k] = chartState.series[k].filter((p) => p.t >= cutoff);
      }
      renderOverviewChart();
    }
  }, 3000);
});

// ---------------------------------------------------------------------------
// Refreshers
// ---------------------------------------------------------------------------

async function refreshAll() {
  await Promise.all([refreshStrategies(), refreshKeys(), refreshSnapshot(), refreshFailoverTuning()]);
}

async function refreshFailoverTuning() {
  try {
    state.failoverTuning = await api.failoverTuning();
  } catch {
    state.failoverTuning = null;
  }
}

function initBreakStickiness() {
  const btn = $('#break-stickiness-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Forget all sticky session → key pins? The next request for each session re-selects by routing strategy.')) return;
    try {
      await api.clearSessions();
      toast('Session stickiness cleared', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function refreshStrategies() {
  const [strategiesRes, currentRes] = await Promise.all([
    api.strategies(),
    api.currentStrategy(),
  ]);
  state.strategies = strategiesRes.strategies || [];
  state.activeStrategy = currentRes.strategy;
  renderRouting();
  $('#footer-strategy').textContent = state.activeStrategy.replace(/_/g, ' ');
}

async function refreshKeys() {
  const keys = await api.keys();
  state.keys = keys;
  $('#nav-keys-count').textContent = String(keys.filter((k) => k.enabled).length);
  renderAccounts();
  if (state.currentPage === 'overview') renderOverview();
}

async function refreshSnapshot() {
  const data = await api.status();
  state.summary = data.summary;
  state.keys = data.keys;
  $('#nav-keys-count').textContent = String(data.summary.enabledKeys);
  if (state.currentPage === 'overview') renderOverview();
  renderAccounts();
  if (state.currentPage === 'routing') renderRouting();
}

window.__refreshAll = refreshAll;
window.__refreshKeys = refreshKeys;
window.__refreshSnapshot = refreshSnapshot;

// ---------------------------------------------------------------------------
// WebSocket — live logs + connection status
// ---------------------------------------------------------------------------

let ws = null;
let wsReconnectTimer = null;

function setStatus(connected) {
  const pill = $('#status-badge');
  const text = pill.querySelector('.status-text');
  pill.classList.toggle('connected', connected);
  text.textContent = connected ? 'Connected' : 'Disconnected';
}

function connectWebSocket() {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/logs`);
  ws.onopen = () => {
    setStatus(true);
  };
  ws.onclose = () => {
    setStatus(false);
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let entry;
    try { entry = JSON.parse(ev.data); } catch { return; }
    ingestLog(entry);
  };
}

// Backfill from /api/logs so the page is useful immediately after load
async function backfillLogs() {
  try {
    const logs = await api.recentLogs();
    // If WebSocket already populated the buffer, don't nuke it
    if (state.recentLogs.length > 0) return;
    for (const e of logs) ingestLog(e, { initial: true });
  } catch (err) {
    console.warn('Failed to backfill logs', err);
  }
}

function ingestLog(entry, { initial = false } = {}) {
  // Idempotency: assign id based on timestamp + message hash
  if (!entry.__id) {
    entry.__id = `${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  if (state.paused && !initial) {
    state.pausedBuffer.push(entry);
    if (state.pausedBuffer.length > 500) state.pausedBuffer.shift();
    return;
  }

  // Maintain ring buffer of 500
  state.recentLogs.push(entry);
  if (state.recentLogs.length > 500) {
    const evicted = state.recentLogs.shift();
    state.archivedLogs.push(evicted);
    if (state.archivedLogs.length > 10000) state.archivedLogs.shift();
  }
  state.logById.set(entry.__id, entry);

  if (entry.meta?.method) {
    pushChartPoint(entry);
  }

  if (state.currentPage === 'logs') {
    scheduleLogRender();
    if (logFollow && !state.paused) scrollLogToTop();
  }
  if (state.currentPage === 'overview') {
    scheduleOverviewChart();
  }
  if (state.currentPage === 'tokens') {
    scheduleTokensRender();
  }
}

// ---------------------------------------------------------------------------
// Modal — Add key
// ---------------------------------------------------------------------------

function initModal() {
  const overlay = $('#add-key-modal');
  $('#add-key-btn').addEventListener('click', () => {
    $('#key-alias-input').value = '';
    $('#key-value-input').value = '';
    $('#key-priority-input').value = String((state.keys[state.keys.length - 1]?.priority ?? 0) + 1);
    $('#key-weight-input').value = '1';
    overlay.classList.add('active');
    setTimeout(() => $('#key-alias-input').focus(), 50);
  });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', saveNewKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closeModal();
  });
}

function closeModal() { $('#add-key-modal').classList.remove('active'); }

async function saveNewKey() {
  const alias = $('#key-alias-input').value.trim();
  const key = $('#key-value-input').value.trim();
  const priority = Number($('#key-priority-input').value || '1');
  const weight = Number($('#key-weight-input').value || '1');
  if (!key) { toast('API key is required', 'error'); return; }
  try {
    await api.addKey({ key, alias: alias || undefined, priority, weight });
    toast('Key added', 'success');
    closeModal();
    await refreshKeys();
  } catch (err) {
    toast(err.message || 'Failed to add key', 'error');
  }
}

// ---------------------------------------------------------------------------
// Page: Overview
// ---------------------------------------------------------------------------

function renderOverview() {
  if (!state.summary) return;
  renderOverviewKpis();
  renderQuotaErrors();
  renderTokenBreakdown();
  renderToken30d();
  renderModelDonut();
  renderOverviewChart();
}

function renderOverviewKpis() {
  const s = state.summary || {};
  const kpis = [
    { label: 'Enabled keys', value: s.enabledKeys ?? 0, accent: 'accent' },
    {
      label: 'Servable now',
      value: s.effectiveAvailable ?? 0,
      accent: (s.effectiveAvailable ?? 0) === 0 ? 'red' : (s.effectiveAvailable ?? 0) < (s.enabledKeys ?? 0) ? 'yellow' : 'green',
      title: 'Enabled + active + breaker-closed. When this hits 0 the next turn 503s — drain/rest is the move, not retries.',
    },
    { label: 'Cooldown', value: s.cooldownKeys ?? 0, accent: s.cooldownKeys ? 'yellow' : '' },
    { label: 'Open breakers', value: s.openBreakers ?? 0, accent: (s.openBreakers ?? 0) > 0 ? 'yellow' : '' },
    { label: 'Requests', value: fmtTokens(s.totalRequests ?? 0) },
    { label: 'Quota errors', value: fmtNumber(s.quotaErrorCount ?? 0), accent: (s.quotaErrorCount ?? 0) > 0 ? 'yellow' : '' },
  ];
  $('#overview-kpis').innerHTML = kpis.map((k) => `
    <div class="kpi"${k.title ? ` title="${escapeHtml(k.title)}"` : ''}>
      <span class="kpi-label">${escapeHtml(k.label)}</span>
      <span class="kpi-value ${k.accent || ''}">${escapeHtml(String(k.value))}</span>
    </div>
  `).join('');
}

function renderQuotaErrors() {
  const keys = state.keys || [];
  const rows = keys
    .filter((k) => (k.quotaErrorCount || 0) > 0 || k.lastQuotaError)
    .sort((a, b) => (b.quotaErrorCount || 0) - (a.quotaErrorCount || 0));

  const total = keys.reduce((sum, k) => sum + (k.quotaErrorCount || 0), 0);
  $('#recon-meta').textContent = total === 0
    ? 'No upstream quota errors observed yet'
    : `${total} upstream quota error${total === 1 ? '' : 's'} caught this session`;

  const body = $('#recon-body');
  if (rows.length === 0) {
    // Healthy state: collapse the billboard to one line, keep the explainer
    // one hover away. Frees half a row for the throughput chart.
    body.innerHTML = `
      <div style="padding: 10px 16px; font-size: 12px; color: var(--text-secondary);"
        title="The router only cools down a key on upstream 402 or quota-marked 429.">✓ No quota errors</div>
    `;
    return;
  }

  body.innerHTML = rows.map((k) => {
    const last = k.lastQuotaError;
    const lastStatus = last ? `HTTP ${last.statusCode}` : '';
    const lastAt = last ? `at ${fmtDateTime(new Date(last.occurredAt).toISOString())}` : '';
    const resetAt = last && last.resetAt ? `retry ${fmtDateTime(new Date(last.resetAt).toISOString())}` : '';
    const msg = last && last.message ? last.message : '';
    return `
      <div class="recon-row">
        <div class="recon-label">
          <div class="recon-key">${escapeHtml(k.alias)}</div>
          <div class="recon-key-sub">${k.enabled ? 'enabled' : 'drained'}${k.status === 'cooldown' ? ' · cooldown' : ''}</div>
        </div>
        <div class="recon-bar router" title="Quota error count"><div style="width:0%"></div></div>
        <div class="recon-bar opencode" title="Quota error count"><div style="width:0%"></div></div>
        <div class="recon-amount">
          <div><strong>${fmtNumber(k.quotaErrorCount)}</strong> hit${k.quotaErrorCount === 1 ? '' : 's'}</div>
          <div class="recon-amount-sub">${escapeHtml([lastStatus, lastAt, resetAt].filter(Boolean).join(' · '))}</div>
          ${msg ? `<div class="recon-amount-sub" title="${escapeHtml(msg)}">${escapeHtml(msg.length > 60 ? msg.slice(0, 60) + '…' : msg)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

const BREAKDOWN_WINDOWS = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All-time' },
];
let breakdownWindow = '24h';

function breakdownTotals() {
  const keys = state.keys || [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const k of keys) {
    // recentUsage.* are rolling windows from the usage log; quota.tokensBreakdown is lifetime.
    // No fallbacks: a missing window renders as zeros, never as a different window's data.
    const u = breakdownWindow === 'all'
      ? (k.quota?.tokensBreakdown || {})
      : breakdownWindow === '7d'
        ? (k.recentUsage?.last7d || {})
        : breakdownWindow === '24h'
          ? (k.recentUsage?.last24h || {})
          : (k.recentUsage?.last30d || {});
    totals.input += u.input || 0;
    totals.output += u.output || 0;
    totals.cacheRead += u.cacheRead || 0;
    totals.cacheWrite += u.cacheWrite || 0;
    totals.reasoning += u.reasoning || 0;
  }
  return totals;
}

function renderTokenBreakdown() {
  const totals = breakdownTotals();
  const sum = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
  const pct = (v) => sum > 0 ? (v / sum) * 100 : 0;
  const windowLabel = breakdownWindow === 'all' ? 'all-time' : `last ${breakdownWindow}`;
  $('#breakdown-body').innerHTML = `
    <div style="display: grid; gap: 10px;">
      <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;" role="group" aria-label="Breakdown window">
        ${BREAKDOWN_WINDOWS.map((w) => `<button class="btn btn-sm ${breakdownWindow === w.id ? 'btn-primary' : ''}" data-bw="${w.id}">${w.label}</button>`).join('')}
        <span style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono);">${fmtTokens(sum)} tok in ${windowLabel}</span>
      </div>
      <div class="stacked-bar" title="Input / Output / Cache read / Cache write / Reasoning">
        <span class="seg-input" style="width:${pct(totals.input).toFixed(2)}%"></span>
        <span class="seg-output" style="width:${pct(totals.output).toFixed(2)}%"></span>
        <span class="seg-cr" style="width:${pct(totals.cacheRead).toFixed(2)}%"></span>
        <span class="seg-cw" style="width:${pct(totals.cacheWrite).toFixed(2)}%"></span>
        <span class="seg-r" style="width:${pct(totals.reasoning).toFixed(2)}%"></span>
      </div>
      <div class="chart-legend" style="padding: 0;">
        <span><span class="swatch" style="background: var(--accent);"></span>Input ${fmtTokens(totals.input)}</span>
        <span><span class="swatch" style="background: var(--green);"></span>Output ${fmtTokens(totals.output)}</span>
        <span><span class="swatch" style="background: var(--purple);"></span>Cache read ${fmtTokens(totals.cacheRead)}</span>
        <span><span class="swatch" style="background: var(--yellow);"></span>Cache write ${fmtTokens(totals.cacheWrite)}</span>
        <span><span class="swatch" style="background: var(--red);"></span>Reasoning ${fmtTokens(totals.reasoning)}</span>
      </div>
    </div>
  `;
  $$('#breakdown-body [data-bw]').forEach((el) => {
    el.addEventListener('click', () => {
      breakdownWindow = el.dataset.bw;
      renderTokenBreakdown();
    });
  });
}

function renderToken30d() {
  // Folded into renderTokenBreakdown (window toggle covers 30d). Kept as a
  // no-op so renderOverview() call sites don't break; the card was removed.
}

const DONUT_COLORS = ['var(--accent)', 'var(--green)', 'var(--purple)', 'var(--yellow)', 'var(--red)', '#f9a825', '#7c4dff', '#00bfa5', '#ff6d00', '#536dfe', 'var(--text-faint)'];

function renderModelDonut() {
  const host = $('#overview-model-donut');
  if (!host) return;
  const now = Date.now();
  const cutoff = now - 86400000;
  const entries = getTokenLogsInWindow(86400000, now);
  const { byModel } = aggregateAll(entries);
  const vm = state.visibleModels;
  if (vm && vm.length) {
    for (const [model] of byModel) {
      if (!vm.includes(model)) byModel.delete(model);
    }
  }
  const sorted = [...byModel.entries()]
    .map(([model, data]) => ({
      model,
      total: data.input + data.output + data.cacheRead + data.cacheWrite + data.reasoning,
      errRate: data.requests > 0 ? (data.errors || 0) / data.requests : 0,
    }))
    .sort((a, b) => b.total - a.total);
  if (!sorted.length) { host.innerHTML = '<div class="empty-state">No token data in the last 24h.</div>'; return; }
  const top = sorted.slice(0, 8);
  const other = sorted.slice(8);
  const otherTotal = other.reduce((s, m) => s + m.total, 0);
  if (otherTotal > 0) top.push({ model: 'Other', total: otherTotal });
  const grandTotal = top.reduce((s, m) => s + m.total, 0);
  const radius = 50;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  const segments = top.map((m, i) => {
    const pct = m.total / grandTotal;
    const len = pct * circ;
    const seg = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="18" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" />`;
    offset += len;
    return seg;
  }).join('');
  const legend = top.map((m, i) => {
    const errColor = m.errRate < 0.05 ? 'var(--green)' : m.errRate < 0.20 ? 'var(--yellow)' : 'var(--red)';
    const errText = `<span style="color:${errColor};" title="Share of 24h requests for this model that ended 4xx/5xx or transport-failed.">err ${(m.errRate * 100).toFixed(0)}%</span>`;
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary);">
      <span style="width:8px;height:8px;border-radius:2px;background:${DONUT_COLORS[i % DONUT_COLORS.length]};flex-shrink:0;"></span>
      ${escapeHtml(m.model)} <strong style="color:var(--text);">${(m.total / grandTotal * 100).toFixed(1)}%</strong> ${errText}
    </span>`;
  }).join('');
  host.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;padding:8px 0;">
      <svg width="120" height="120" viewBox="0 0 120 120" style="flex-shrink:0;">
        <circle cx="60" cy="60" r="${radius}" fill="none" stroke="var(--border)" stroke-width="18" />
        ${segments}
        <circle cx="60" cy="60" r="33" fill="var(--bg-elev-2)" />
        <text x="60" y="60" text-anchor="middle" dominant-baseline="central" fill="var(--text)" font-size="16" font-weight="700">${fmtTokens(grandTotal)}</text>
      </svg>
      <div style="display:flex;flex-wrap:wrap;gap:4px 0;flex:1;">${legend}</div>
    </div>
  `;
}

// ---- Charts: token throughput over time -------------------------------

let chartState = {
  series: { input: [], output: [], cacheRead: [], cacheWrite: [], reasoning: [] },
  maxPoints: 240,    // 4 minutes at 1s tick
  byKey: new Map(),  // keyAlias -> { tokens, fails: [{t, status}] }
  lastTickMs: 0,
};

function pushChartPoint(entry) {
  const meta = entry.meta || {};
  const t = meta.tokens || {};
  if (!entry.timestamp) return;
  const ts = new Date(entry.timestamp).getTime();
  if (Number.isNaN(ts)) return;
  if (t.input == null && t.output == null && t.cacheRead == null && t.cacheWrite == null && t.reasoning == null) return;
  for (const key of Object.keys(chartState.series)) {
    chartState.series[key].push({ t: ts, v: t[key] || 0 });
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const key of Object.keys(chartState.series)) {
    chartState.series[key] = chartState.series[key].filter((p) => p.t >= cutoff);
    if (chartState.series[key].length > chartState.maxPoints) {
      chartState.series[key] = chartState.series[key].slice(-chartState.maxPoints);
    }
  }
  // Per-key thread for small-multiples + failure tick strip.
  const alias = meta.keyAlias || '(unknown)';
  let slot = chartState.byKey.get(alias);
  if (!slot) { slot = { tokens: 0, fails: [] }; chartState.byKey.set(alias, slot); }
  slot.tokens += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0);
  const sc = meta.statusCode;
  if (sc === 429 || (typeof sc === 'number' && sc >= 500)) {
    slot.fails.push({ t: ts, status: sc });
    slot.fails = slot.fails.filter((f) => f.t >= cutoff).slice(-120);
  }
}

const CHART_RERENDER_MS = 5000;

function renderOverviewChart(force = false) {
  const host = $('#overview-chart');
  if (!host) return;
  // Throttle re-renders: the x-domain is data-driven, so re-rendering on
  // every log tick shifts the whole chart. 5s cadence keeps recent activity
  // live without moving history under the reader.
  const now = Date.now();
  if (!force && now - chartState.lastTickMs < CHART_RERENDER_MS && host.dataset.rendered === '1') return;
  chartState.lastTickMs = now;
  host.dataset.rendered = '1';
  const series = chartState.series;
  const all = [...series.input, ...series.output, ...series.cacheRead, ...series.cacheWrite, ...series.reasoning];
  if (all.length < 2) {
    host.innerHTML = `<div style="height: 220px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 12px; font-family: var(--font-mono);">Waiting for token activity…</div>`;
    return;
  }
  const strip = overviewFailStripSvg({ height: 26 });
  const svg = overviewStackedAreaSvg(series, { width: 560, height: 196, padding: { top: 8, right: 12, bottom: 24, left: 40 } });
  // overviewStackedAreaSvg stashes its truthful legend HTML for the caller.
  const legend = overviewStackedAreaSvg.lastLegend || '';
  host.innerHTML = svg
    + legend
    + `<div style="margin-top:6px;padding-bottom:12px;"><div style="font-size:10px;color:var(--text-secondary);font-family:var(--font-mono);margin-bottom:2px;">429 / 5xx per key (last 1h)</div>${strip}</div>`;
  const staticLegend = host.parentElement ? host.parentElement.querySelector(':scope > .chart-legend') : null;
  if (staticLegend && legend) staticLegend.style.display = 'none';
}

// One row per key: yellow tick = 429, red tick = 5xx. Answers "which key is burning".
function overviewFailStripSvg({ height }) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const rows = [...chartState.byKey.entries()]
    .map(([alias, slot]) => ({ alias, fails: slot.fails.filter((f) => f.t >= cutoff) }))
    .filter((r) => r.fails.length > 0)
    .slice(0, 6);
  if (!rows.length) return `<div style="font-size:11px;color:var(--text-secondary);">No 429/5xx in the last hour.</div>`;
  const W = 560, labelW = 110, rowH = Math.max(14, Math.floor((height || 26) / 1));
  const tMin = cutoff, tMax = Date.now();
  const span = Math.max(1, tMax - tMin);
  const x = (t) => labelW + ((t - tMin) / span) * (W - labelW - 8);
  return `<svg width="100%" viewBox="0 0 ${W} ${rows.length * rowH + 4}" style="display:block;">` + rows.map((r, i) => {
    const y = i * rowH + rowH / 2;
    const ticks = r.fails.map((f) => {
      const color = f.status === 429 ? 'var(--yellow)' : 'var(--red)';
      return `<line x1="${x(f.t).toFixed(1)}" y1="${(y - 4).toFixed(1)}" x2="${x(f.t).toFixed(1)}" y2="${(y + 4).toFixed(1)}" stroke="${color}" stroke-width="2"><title>${escapeHtml(r.alias)} · HTTP ${f.status} · ${new Date(f.t).toLocaleTimeString()}</title></line>`;
    }).join('');
    return `<text x="0" y="${(y + 3).toFixed(1)}" font-size="10" fill="var(--text-secondary)" font-family="var(--font-mono)">${escapeHtml(r.alias.slice(0, 14))}</text>${ticks}`;
  }).join('') + `</svg>`;
}

const scheduleOverviewChart = rAFThrottle(() => {
  if (state.currentPage === 'overview') renderOverviewChart();
});

function overviewStackedAreaSvg(rawSeries, opts) {
  const { width, height, padding } = opts;
  const all = [...rawSeries.input, ...rawSeries.output, ...rawSeries.cacheRead, ...rawSeries.cacheWrite, ...rawSeries.reasoning];
  if (all.length < 2) return '';
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const spanMs = Math.max(1, tMax - tMin);
  const bucketMs = Math.max(10_000, Math.ceil(spanMs / 48));
  const bucketCount = Math.ceil(spanMs / bucketMs);
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = tMin + i * bucketMs;
    const end = start + bucketMs;
    const bucket = { t: start, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    for (const key of Object.keys(rawSeries)) {
      const pts = rawSeries[key].filter((p) => p.t >= start && p.t < end);
      bucket[key] = pts.reduce((s, p) => s + p.v, 0);
    }
    buckets.push(bucket);
  }

  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const x = (t) => padding.left + ((t - tMin) / spanMs) * innerW;
  const bucketW = (spanMs > 0 ? (bucketMs / spanMs) * innerW : 0);

  // Calculate stacked values per bucket. Categories that carry no tokens in
  // this window are skipped: a zero band adds no shape but its stroke would
  // still draw a phantom line at another band's edge.
  const stackKeys = ['cacheRead', 'input', 'output', 'cacheWrite', 'reasoning'];
  const stackColors = ['var(--purple)', 'var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--red)'];
  const activeKeys = stackKeys.filter((k) => buckets.some((b) => (b[k] || 0) > 0));
  const drawKeys = activeKeys.length ? activeKeys : stackKeys.slice(0, 1);
  const stackTops = buckets.map(() => 0);
  let vMax = 0;
  for (const k of drawKeys) {
    for (let i = 0; i < buckets.length; i++) {
      stackTops[i] += buckets[i][k];
    }
    vMax = Math.max(vMax, ...stackTops);
  }
  vMax = Math.max(1, vMax * 1.1);

  const y = (v) => padding.top + innerH - (v / vMax) * innerH;

  // Horizontal grid lines
  const hGrid = [];
  for (let i = 0; i <= 4; i++) {
    const yy = padding.top + (innerH / 4) * i;
    hGrid.push(`<line x1="${padding.left}" y1="${yy}" x2="${width - padding.right}" y2="${yy}"/>`);
  }

  // X-axis ticks
  let tickIntervalMs;
  if (spanMs <= 120_000) tickIntervalMs = 10_000;
  else if (spanMs <= 300_000) tickIntervalMs = 30_000;
  else if (spanMs <= 600_000) tickIntervalMs = 60_000;
  else if (spanMs <= 1_800_000) tickIntervalMs = 300_000;
  else tickIntervalMs = 600_000;

  const ticks = [];
  if (tickIntervalMs > 0) {
    const firstTick = Math.ceil(tMin / tickIntervalMs) * tickIntervalMs;
    for (let t = firstTick; t <= tMax; t += tickIntervalMs) ticks.push(t);
  }

  const labelMinPx = 60;
  const maxLabels = Math.max(1, Math.floor(innerW / labelMinPx));
  const labelStep = Math.max(1, Math.ceil(ticks.length / maxLabels));
  const fmtTick = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  const vGridAndLabels = ticks.map((t, i) => {
    const xx = x(t).toFixed(1);
    const showLabel = i % labelStep === 0 || i === ticks.length - 1;
    return `
      <line x1="${xx}" y1="${padding.top}" x2="${xx}" y2="${padding.top + innerH}" class="grid-v"/>
      ${showLabel ? `<text x="${xx}" y="${height - 6}" text-anchor="middle" font-size="10" class="axis-tick">${fmtTick(t)}</text>` : ''}
    `;
  }).join('');

  // Stacked area bands (from bottom to top). Bands are areas only — the single
  // outline is the neutral TOTAL line below, so no category color ever
  // impersonates a series. The polygon traces the upper edge forward and the
  // lower edge BACKWARD per bucket (never a flat close to one point).
  function stackedAreas(key, colorIdx, prevTops) {
    if (buckets.length < 2) return '';
    const upper = buckets.map((b, i) => {
      const top = prevTops[i] + b[key];
      return { x: x(b.t), y: y(top) };
    });
    const d = upper.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')
      + ' ' + buckets.map((b, i) => {
        const j = buckets.length - 1 - i;
        return 'L' + x(buckets[j].t).toFixed(1) + ',' + y(prevTops[j]).toFixed(1);
      }).join(' ') + ' Z';
    // Update tops for next series
    for (let i = 0; i < prevTops.length; i++) prevTops[i] += buckets[i][key];
    const topD = upper.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
    return `<path class="series-fill" fill="${stackColors[colorIdx]}" d="${d}" opacity="0.15"/>
      <path class="series" stroke="${stackColors[colorIdx]}" fill="none" stroke-width="1" opacity="0.5" d="${topD}"/>`;
  }

  const stacks = [];
  const tops = buckets.map(() => 0);
  const keyColorIdx = new Map(stackKeys.map((k, i) => [k, i]));
  for (const k of drawKeys) {
    stacks.push(stackedAreas(k, keyColorIdx.get(k), tops));
  }
  overviewStackedAreaSvg.lastLegend = overviewLegendSvg(drawKeys, keyColorIdx, stackColors, buckets);
  // Neutral total outline: the stack top across all categories. Invisible fat
  // hit path per vertex gives hover values without changing the picture.
  const totalPts = buckets.map((b, i) => {
    let acc = 0;
    for (const k of drawKeys) acc += b[k];
    return { x: x(b.t), y: y(acc), t: b.t, total: acc };
  });
  const totalD = totalPts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const fmtBucketT = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const totalLine = buckets.length >= 2
    ? `<path fill="none" stroke="var(--text)" stroke-width="1.5" opacity="0.8" d="${totalD}"/>`
      + totalPts.map((p) => {
        const parts = drawKeys.map((k) => `${k.replace(/([A-Z])/g, ' $1')}: ${fmtTokens(buckets[totalPts.indexOf(p)][k] || 0)}`).join(' · ');
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="transparent"><title>${fmtBucketT(p.t)} — total ${fmtTokens(p.total)} (${parts})</title></circle>`;
      }).join('')
    : '';

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
      <g class="grid">${hGrid.join('')}</g>
      <g class="grid-v">${vGridAndLabels}</g>
      <g class="axis">
        <text x="4" y="${padding.top + 8}">${fmtTokens(vMax)}</text>
        <text x="4" y="${padding.top + innerH}">0</text>
      </g>
      ${stacks.join('')}
      ${totalLine}
    </svg>
  `;
}

// In-SVG legend: only drawn categories + Total, each with its window total.
// Static HTML legend in index.html is hidden by renderOverviewChart; this one
// can't lie because it's built from the same drawKeys as the bands.
function overviewLegendSvg(drawKeys, keyColorIdx, stackColors, buckets) {
  const totals = {};
  for (const k of drawKeys) totals[k] = buckets.reduce((s, b) => s + (b[k] || 0), 0);
  const items = drawKeys.map((k) => {
    const i = keyColorIdx.get(k);
    const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
    return `<span><span class="swatch" style="background:${stackColors[i]};"></span>${escapeHtml(label)} ${fmtTokens(totals[k])}</span>`;
  });
  items.push(`<span style="color:var(--text);">— Total</span>`);
  return `<div class="chart-legend" style="padding:4px 0 0;">${items.join('')}</div>`;
}

// 5m per-key readout from the persisted log buffer (survives reload,
// unlike the old requestRateByKey page-memory map). err = statusCode >= 400 or 0 (transport).
function keyLast5m(keyId) {
  const cutoff = Date.now() - 5 * 60 * 1000;
  let req = 0, err = 0;
  for (const buf of [state.archivedLogs, state.recentLogs]) {
    if (!buf) continue;
    for (const e of buf) {
      if (e.meta?.keyId !== keyId) continue;
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (ts < cutoff) continue;
      req++;
      const sc = e.meta?.statusCode;
      if (typeof sc !== 'number' || sc >= 400) err++;
    }
  }
  return { req, err };
}

// ---------------------------------------------------------------------------
// Page: Accounts
// ---------------------------------------------------------------------------

function renderAccounts() {
  const host = $('#account-list');
  if (!host) return;
  if (state.keys.length === 0) {
    host.innerHTML = `
      <div class="empty-state">
        <strong>No accounts yet</strong>
        Add your first OpenCode Go API key to start routing traffic across multiple accounts.
        <div style="margin-top: 14px;">
          <button class="btn btn-primary" onclick="document.getElementById('add-key-btn').click()">+ Add key</button>
        </div>
      </div>
    `;
    return;
  }
  host.innerHTML = state.keys.map(renderAccountCard).join('');
  initAccountCardHandlers(host);
}

function renderAccountCard(key) {
  const b = key.quota?.tokensBreakdown || {};
  const total = (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.reasoning || 0);
  const pct = (v) => total > 0 ? (v / total) * 100 : 0;
  const w5 = keyLast5m(key.id);
  const w5color = w5.err === 0 ? 'var(--green)' : (w5.err / Math.max(1, w5.req)) < 0.2 ? 'var(--yellow)' : 'var(--red)';
  const w5html = `<span class="w5" title="Requests (errors) in the last 5 minutes, from the persisted log buffer."><span class="label">5m</span><strong>${w5.req} req · <span style="color:${w5color};">${w5.err} err</span></strong></span>`;
  const lastModel = key.lastModel || '—';
  const cooldown = key.cooldownUntil && key.cooldownUntil > Date.now()
    ? `<span class="account-cooldown">cooldown ${fmtCooldown(key.cooldownUntil)}</span>` : '';
  const status = key.enabled ? (key.status === 'cooldown' ? 'cooldown' : 'active') : 'drained';
  const statusChip = key.enabled
    ? (key.status === 'cooldown' ? '<span class="chip chip-yellow">cooldown</span>' : '<span class="chip chip-green">active</span>')
    : '<span class="chip chip-muted">drained</span>';

  const quotaErrorCount = key.quotaErrorCount || 0;
  const lastQuotaError = key.lastQuotaError;
  const quotaErrorChip = quotaErrorCount > 0
    ? `<span class="chip chip-red" title="Upstream told us this key was exhausted ${quotaErrorCount} time${quotaErrorCount === 1 ? '' : 's'}. The router will not route to this key until the upstream-supplied retry time.">quota ${quotaErrorCount}</span>`
    : '';
  const lastQuotaLine = lastQuotaError
    ? `<div class="account-quota-line">Last quota error: <strong>HTTP ${lastQuotaError.statusCode}</strong> ${escapeHtml(lastQuotaError.message || '')}${lastQuotaError.resetAt ? ` · retry ${fmtDateTime(new Date(lastQuotaError.resetAt).toISOString())}` : ''}</div>`
    : '';

  let circuitChip = '';
  if (key.health === 'open') {
    const msLeft = typeof key.breakerSelfCancelAt === 'number' ? key.breakerSelfCancelAt - Date.now() : null;
    const countdown = msLeft !== null && msLeft > 0 ? ` · self-cancel in ~${Math.ceil(msLeft / 1000)}s` : ' · self-cancelling';
    const tripAt = typeof key.breakerTrippedAt === 'number' ? ` Tripped ${new Date(key.breakerTrippedAt).toLocaleTimeString()}.` : '';
    circuitChip = `<span class="chip chip-red" title="Circuit breaker OPEN — this key is skipped; traffic fails over.${tripAt} It releases to half-open automatically, no traffic needed.">⏻ open${escapeHtml(countdown)}</span>`;
  } else if (key.health === 'half_open') {
    circuitChip = '<span class="chip chip-yellow" title="Circuit breaker HALF-OPEN — the next request probes this key: success closes the breaker, failure re-trips it.">◐ half-open</span>';
  }

  const errorRate = key.requestCount > 0 ? ((key.errorCount / key.requestCount) * 100) : 0;
  const errRateColor = errorRate < 5 ? 'var(--green)' : errorRate < 20 ? 'var(--yellow)' : 'var(--red)';
  const errRateText = errorRate > 0 ? `<span style="color:${errRateColor};font-weight:600;">${errorRate.toFixed(1)}%</span>` : '0%';

  const tuning = state.failoverTuning;
  const breakerProgress = tuning
    ? `<span><span class="label">Brk</span><strong>${key.consecutiveErrors ?? 0}/${tuning.circuitBreakerThreshold} · win ${key.windowFailureCount ?? 0}/${tuning.windowFailures}</strong></span>`
    : '';
  const hint = (key.requestCount || 0) >= 30 && errorRate >= 30
    ? `<div class="account-hint">⚠ ${escapeHtml(key.alias)} at ${errorRate.toFixed(0)}% errors — consider Rest 12h or Break stickiness.</div>`
    : '';

  return `
    <article class="account-card ${key.enabled ? '' : 'is-muted'}" data-id="${key.id}">
      <div class="drag-handle" draggable="true" title="Drag to reorder">⋮⋮</div>

      <div class="account-primary">
        <h3 class="account-alias" contenteditable="true" spellcheck="false" data-alias-id="${key.id}">${escapeHtml(key.alias)}</h3>
        <div class="account-masked">
          <code>${escapeHtml(key.masked)}</code>
          <button class="btn btn-ghost btn-sm" data-action="reveal" data-id="${key.id}">Replace key</button>
        </div>
        <div class="account-actions" style="margin-top: 8px;">
          ${statusChip}
          ${circuitChip}
          ${quotaErrorChip}
          ${cooldown}
        </div>
        ${lastQuotaLine}
      </div>

      <div class="account-meta">
        <div class="account-meta-row">
          <span><span class="label">Pri</span><strong>#${key.priority}</strong></span>
          <span><span class="label">Wt</span><strong>${key.weight}</strong></span>
          <span><span class="label">Req</span><strong>${fmtTokens(key.requestCount)}</strong></span>
          <span><span class="label">Err</span><strong>${fmtTokens(key.errorCount)} (${errRateText})</strong></span>
          <span><span class="label">Lat</span><strong>${key.averageLatencyMs ? `${Math.round(key.averageLatencyMs)}ms` : '—'}</strong></span>
          <span><span class="label">Last</span><strong>${escapeHtml(lastModel)}</strong></span>
        </div>
        <div class="account-meta-row">
          <span><span class="label">7d</span><strong>${fmtTokens(key.recentUsage?.last7d?.totalTokens || 0)} tok</strong></span>
          <span><span class="label">30d</span><strong>${fmtTokens(key.recentUsage?.last30d?.totalTokens || 0)} tok</strong></span>
          <span><span class="label">Mo</span><strong>${fmtTokens(key.recentUsage?.calendarMonth?.totalTokens || 0)} tok</strong></span>
          ${breakerProgress}
        </div>
        ${hint}
      </div>

      <div class="account-stat-bar">
        <div class="account-sparkline-wrap">
          ${w5html}
        </div>
        <div class="account-stackedwrap">
          <div class="stacked-bar" title="Token breakdown for this account (all time)">
            <span class="seg-input" style="width:${pct(b.input || 0).toFixed(2)}%"></span>
            <span class="seg-output" style="width:${pct(b.output || 0).toFixed(2)}%"></span>
            <span class="seg-cr" style="width:${pct(b.cacheRead || 0).toFixed(2)}%"></span>
            <span class="seg-cw" style="width:${pct(b.cacheWrite || 0).toFixed(2)}%"></span>
            <span class="seg-r" style="width:${pct(b.reasoning || 0).toFixed(2)}%"></span>
          </div>
          <span class="account-legend-mini">I ${fmtTokens(b.input || 0)} · O ${fmtTokens(b.output || 0)} · CR ${fmtTokens(b.cacheRead || 0)}</span>
        </div>
        <div class="account-actions">
          <button class="btn btn-sm" data-action="reset" data-id="${key.id}">Reset cooldown</button>
          <button class="btn btn-sm" data-action="rest" data-id="${key.id}" title="Park this key in cooldown for 12h (manual relief, no quota signal needed).">Rest 12h</button>
          <button class="btn btn-sm" data-action="reset-breaker" data-id="${key.id}" title="Force the circuit breaker CLOSED and zero its failure counters.">Reset breaker</button>
          <button class="btn btn-sm" data-action="reset-stats" data-id="${key.id}" title="Zero REQ/ERR/LAT counters and quota totals for this key (display counters only; also clears breaker and quota window).">Reset stats</button>
          <button class="btn btn-sm" data-action="test" data-id="${key.id}">Test</button>
          <div class="toggle ${key.enabled ? 'on' : ''}" data-action="toggle" data-id="${key.id}" role="switch" aria-checked="${key.enabled}"></div>
          <button class="btn btn-sm btn-danger" data-action="remove" data-id="${key.id}">Remove</button>
        </div>
      </div>
    </article>
  `;
}

function initAccountCardHandlers(host) {
  // Toggle
  $$('.toggle[data-action="toggle"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const key = state.keys.find((k) => k.id === id);
      if (!key) return;
      const enabled = !key.enabled;
      el.classList.toggle('on', enabled);
      try {
        await api.toggleKey(id, enabled);
        toast(enabled ? 'Key enabled' : 'Key drained', 'info');
        await refreshKeys();
      } catch (err) {
        el.classList.toggle('on', !enabled);
        toast(err.message, 'error');
      }
    });
  });

  // Reset cooldown
  $$('button[data-action="reset"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      try { await api.resetCooldown(el.dataset.id); toast('Cooldown reset', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Rest 12h — manual relief: park the key in cooldown for a fixed 12h
  $$('button[data-action="rest"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const key = state.keys.find((k) => k.id === el.dataset.id);
      if (!confirm(`Park "${key ? key.alias : el.dataset.id}" in cooldown for 12h? Traffic fails over to the next account.`)) return;
      try { await api.restKey(el.dataset.id); toast('Key resting for 12h', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Reset breaker — force CLOSED, zero failure counters
  $$('button[data-action="reset-breaker"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      try { await api.resetBreaker(el.dataset.id); toast('Breaker reset', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Reset stats — zero display counters + breaker + quota window
  $$('button[data-action="reset-stats"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const key = state.keys.find((k) => k.id === el.dataset.id);
      if (!confirm(`Reset all counters for "${key ? key.alias : el.dataset.id}"? REQ/ERR, latency, tokens and quota window go to 0 and the breaker is also cleared.`)) return;
      try { await api.resetStats(el.dataset.id); toast('Stats reset', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Test key
  $$('button[data-action="test"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      el.disabled = true;
      el.textContent = 'Testing…';
      try {
        const result = await api.testKey(id);
        if (result.ok) {
          toast(`Key OK (HTTP ${result.status}) — ${result.latencyMs}ms`, 'success');
          el.textContent = '✓ Test';
          setTimeout(() => { el.textContent = 'Test'; el.disabled = false; }, 3000);
        } else {
          toast(`Test failed: ${result.error || `HTTP ${result.status}`}`, 'error');
          el.textContent = '✗ Test';
          setTimeout(() => { el.textContent = 'Test'; el.disabled = false; }, 4000);
        }
      } catch (err) {
        toast(err.message, 'error');
        el.textContent = 'Test';
        el.disabled = false;
      }
    });
  });

  // Remove
  $$('button[data-action="remove"]', host).forEach((el) => {
    el.addEventListener('click', async () => {
      const key = state.keys.find((k) => k.id === el.dataset.id);
      if (!key) return;
      if (!confirm(`Remove "${key.alias}"? This deletes the API key from this device.`)) return;
      try { await api.removeKey(el.dataset.id); toast('Key removed', 'success'); await refreshKeys(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  // Inline alias edit
  $$('.account-alias', host).forEach((el) => {
    const id = el.dataset.aliasId;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') {
        const key = state.keys.find((k) => k.id === id);
        el.textContent = key ? key.alias : el.textContent;
        el.blur();
      }
    });
    el.addEventListener('blur', async () => {
      const newAlias = el.textContent.trim();
      const key = state.keys.find((k) => k.id === id);
      if (!key || newAlias === key.alias) {
        if (key) el.textContent = key.alias;
        return;
      }
      try {
        await api.updateKey(id, { alias: newAlias });
        toast('Renamed', 'success');
        await refreshKeys();
      } catch (err) {
        toast(err.message, 'error');
        el.textContent = key.alias;
      }
    });
  });

  // Replace-key popover
  $$('button[data-action="reveal"]', host).forEach((btn) => {
    btn.addEventListener('click', (e) => openReplacePopover(btn, e));
  });

  // Drag-and-drop reordering
  initAccountDragDrop(host);
}

function openReplacePopover(anchor, evt) {
  closeAllPopovers();
  const id = anchor.dataset.id;
  const pop = document.createElement('div');
  pop.className = 'account-replace-popover';
  pop.innerHTML = `
    <div style="font-size: 12px; color: var(--text-muted); font-family: var(--font-sans);">Replace the stored API key for this account. Stats and alias are kept.</div>
    <input class="input input-mono" placeholder="Paste new OpenCode Go API key" autocomplete="off">
    <div style="display: flex; justify-content: flex-end; gap: 6px;">
      <button class="btn btn-sm" data-popover="cancel">Cancel</button>
      <button class="btn btn-sm btn-primary" data-popover="save">Save</button>
    </div>
  `;
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'absolute';
  pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  pop.style.left = (window.scrollX + rect.left) + 'px';
  const input = pop.querySelector('input');
  setTimeout(() => input.focus(), 30);

  const cleanup = () => pop.remove();
  pop.querySelector('[data-popover="cancel"]').addEventListener('click', cleanup);
  pop.querySelector('[data-popover="save"]').addEventListener('click', async () => {
    const k = input.value.trim();
    if (!k) { toast('Key is required', 'error'); return; }
    try {
      await api.replaceKey(id, k);
      toast('Key replaced', 'success');
      cleanup();
      await refreshKeys();
    } catch (err) { toast(err.message, 'error'); }
  });
  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev) {
      if (!pop.contains(ev.target)) {
        cleanup();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 50);
}

function closeAllPopovers() {
  $$('.account-replace-popover').forEach((el) => el.remove());
}

function initAccountDragDrop(host) {
  const cards = $$('.account-card', host);
  let dragId = null;
  cards.forEach((card) => {
    const handle = card.querySelector('.drag-handle');
    if (!handle) return;
    handle.addEventListener('dragstart', (e) => {
      dragId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    handle.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.account-card', host).forEach((c) => c.classList.remove('drop-target'));
      dragId = null;
    });
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === card.dataset.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.account-card', host).forEach((c) => c.classList.remove('drop-target'));
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      if (!dragId || dragId === card.dataset.id) return;
      const newOrder = state.keys.map((k) => k.id);
      const from = newOrder.indexOf(dragId);
      const to = newOrder.indexOf(card.dataset.id);
      newOrder.splice(from, 1);
      newOrder.splice(to, 0, dragId);
      try {
        await api.reorderKeys(newOrder);
        toast('Priority updated', 'success');
        await refreshKeys();
      } catch (err) {
        toast(err.message || 'Reorder failed', 'error');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Routing
// ---------------------------------------------------------------------------

function renderRouting() {
  const heroHost = $('#strategy-hero-host');
  const gridHost = $('#strategy-grid-host');
  if (!heroHost || !gridHost) return;
  const current = state.strategies.find((s) => s.value === state.activeStrategy);
  if (current) {
    heroHost.innerHTML = `
      <div class="strategy-hero">
        <div>
          <h3>${escapeHtml(current.label)}</h3>
          <p>${escapeHtml(current.description)}</p>
          <div class="strategy-facts">
            <div>
              <div class="label">Best for</div>
              <strong>${escapeHtml(current.bestFor)}</strong>
            </div>
            <div>
              <div class="label">How it works</div>
              <strong>${escapeHtml(current.behavior)}</strong>
            </div>
          </div>
        </div>
        <div class="badges">
          <span class="chip ${current.cacheFriendly ? 'chip-accent' : 'chip-muted'}">${current.cacheFriendly ? 'Cache-friendly' : 'Load-spreading'}</span>
          <span class="chip ${current.usesPriority ? 'chip-purple' : 'chip-muted'}">${current.usesPriority ? 'Uses priority' : 'Priority ignored'}</span>
          <span class="chip ${current.usesWeight ? 'chip-yellow' : 'chip-muted'}">${current.usesWeight ? 'Uses weight' : 'Weight ignored'}</span>
        </div>
      </div>
    `;
  } else {
    heroHost.innerHTML = '';
  }
  gridHost.innerHTML = state.strategies.map((s) => `
    <button class="strategy-card ${s.value === state.activeStrategy ? 'active' : ''}" data-strategy="${s.value}">
      <div class="name">
        <span>${escapeHtml(s.label)}</span>
        ${s.recommended ? '<span class="chip chip-green">Recommended</span>' : ''}
      </div>
      <div class="desc">${escapeHtml(s.description)}</div>
      <div class="best">${escapeHtml(s.bestFor)}</div>
    </button>
  `).join('');
  $$('.strategy-card', gridHost).forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api.setStrategy(el.dataset.strategy);
        state.activeStrategy = el.dataset.strategy;
        $('#footer-strategy').textContent = state.activeStrategy.replace(/_/g, ' ');
        toast(`Switched to ${el.dataset.strategy.replace(/_/g, ' ')}`, 'info');
        renderRouting();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  renderFailoverTuning();
}

async function renderFailoverTuning() {
  const host = $('#failover-tuning-host');
  if (!host) return;
  if (!state.failoverTuning) await refreshFailoverTuning();
  const t = state.failoverTuning;
  if (!t) {
    host.innerHTML = '<div class="empty-state">Failover tuning unavailable.</div>';
    return;
  }
  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Failover tuning</h3>
        <span class="panel-meta">Live-applied, no restart needed</span>
      </div>
      <div class="card-body">
        <p style="margin: 0 0 4px; color: var(--text-secondary); font-size: 13px;">
          A key trips its breaker on <strong>${escapeHtml(String(t.circuitBreakerThreshold))} consecutive failures</strong>
          or <strong>${escapeHtml(String(t.windowFailures))} failures within ${escapeHtml(String(t.windowSeconds))}s</strong> —
          whichever comes first. Only 5xx and burst-429s count; single 200s reset the streak but not the window.
        </p>
        <p style="margin: 0 0 12px; color: var(--text-secondary); font-size: 13px;">
          Tripped keys are skipped, so the next request fails over to a cool account. A tripped key then
          <strong>self-cancels to half-open</strong> after the timeout below — no traffic needed — and the next
          request probes it: success closes the breaker, failure re-trips it. Tuning changes apply live to future
          trips; an already-open key keeps the timeout it tripped with.
        </p>
        <div class="ft-group ft-group-trip">
          <div class="ft-group-label">Trip conditions — either one opens the breaker</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;">
            <label>Streak trip (2–10)<input class="input" type="number" min="2" max="10" id="ft-threshold" value="${t.circuitBreakerThreshold}"><small style="color: var(--text-faint); font-size: 11px;">Unbroken failure run that trips. Lower = faster spill, more false trips on flapping bursts.</small></label>
            <label>Window fails (3–20)<input class="input" type="number" min="3" max="20" id="ft-window-fails" value="${t.windowFailures}"><small style="color: var(--text-faint); font-size: 11px;">Failure count inside the window that trips. Higher = tolerates longer flapping before spilling to the next account.</small></label>
            <label>Window (60–600s)<input class="input" type="number" min="60" max="600" id="ft-window-secs" value="${t.windowSeconds}"><small style="color: var(--text-faint); font-size: 11px;">Slow-burn trip: N failures inside M seconds, even with 200s between them. Catches degrading keys the streak rule misses.</small></label>
          </div>
        </div>
        <div class="ft-group ft-group-recover">
          <div class="ft-group-label">Recovery timing — how a tripped key comes back</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;">
            <label>Recovery (60–900s)<input class="input" type="number" min="60" max="900" id="ft-recovery" value="${Math.round(t.circuitBreakerRecoveryMs / 1000)}"><small style="color: var(--text-faint); font-size: 11px;">Fallback exile length when nothing else sets one. Keep above ~60s so probes don't fire into the same Retry-After window.</small></label>
            <label>Self-cancel (0 or 30–900s)<input class="input" type="number" min="0" max="900" id="ft-self-cancel" value="${Math.round((t.breakerSelfCancelMs || 0) / 1000)}"><small style="color: var(--text-faint); font-size: 11px;">Proactive OPEN → half-open timer, fires without traffic. 0 = follow Recovery. Upstream Retry-After overrides both when honored.</small></label>
            <label>Retry-After cap (60–3600s)<input class="input" type="number" min="60" max="3600" id="ft-cap" value="${Math.round(t.retryAfterCapMs / 1000)}"><small style="color: var(--text-faint); font-size: 11px;">Upper bound for upstream-supplied waits. Caps one Retry-After header from exiling a key for hours.</small></label>
          </div>
        </div>
        <div class="ft-group ft-group-counts">
          <div class="ft-group-label">Failure modes — what each response does to a key</div>
          <div class="ft-legend">
            <span class="chip chip-green" title="Success. Zeroes the consecutive-failure streak. The window ring keeps older failures, so a single 200 does not erase a slow-burn pattern.">2xx resets streak</span>
            <span class="chip chip-red" title="Server-side failure. Always feeds the breaker (streak + window). An exact 500 on Zen chat also triggers one translated retry via /responses on the same key.">5xx feeds breaker</span>
            <span class="chip chip-yellow" title="Burst rate limit (no quota markers). Returned to the client verbatim — no same-request key-burning — but counts toward the breaker when Burst-failover is on, so the NEXT request spills.">burst-429 feeds breaker</span>
            <span class="chip chip-yellow" title="Quota exhaustion (402, or 429 with quota markers). Parks the key in cooldown for the upstream-supplied wait and fails over to the next key within the SAME request.">quota-429 → cooldown + failover</span>
            <span class="chip chip-muted" title="400/403/404 and similar (dashboard probes included). Counted in REQ/ERR for honest stats, but say nothing about key health — they neither feed nor reset the breaker.">other 4xx count-only</span>
            <span class="chip chip-muted" title="Fetch threw or the client disconnected (statusCode 0: connect timeouts, aborts, hung-upstream kills). Counted as an error, but never trips — a cancelled turn must not exile a healthy key.">transport errors never trip</span>
            <span class="chip chip-muted" title="DNS down / no route / Wi-Fi off: the request never left the machine. Counted in REQ/ERR for honesty, but nothing else burns — no breaker feed, no failover cycling. The client gets HTTP 503 'Local network unreachable' instead of 'All API keys failed'.">local outage never burns</span>
          </div>
          <div style="display: flex; gap: 16px; margin-top: 10px; align-items: center; flex-wrap: wrap;">
            <label style="display: flex; gap: 6px; align-items: center; font-size: 13px;" title="Count burst-429s toward the breaker so the NEXT request fails over. Off = pre-tuning behavior: 429s never trip, keys cook.">
              <input type="checkbox" class="ft-input" id="ft-burst" ${t.burstFailoverEnabled ? 'checked' : ''}> Burst-failover
            </label>
            <label style="display: flex; gap: 6px; align-items: center; font-size: 13px;" title="Use the upstream Retry-After header (clamped between Recovery and the cap) as the exile length instead of the flat Recovery value.">
              <input type="checkbox" class="ft-input" id="ft-retry-after" ${t.honorRetryAfter ? 'checked' : ''}> Honor Retry-After
            </label>
            <button class="btn btn-primary btn-sm" id="ft-save">Save tuning</button>
            <span id="ft-dirty" class="ft-dirty" hidden>● unsaved changes</span>
          </div>
        </div>
      </div>
    </div>
  `;
  const ftFields = ['#ft-threshold', '#ft-recovery', '#ft-self-cancel', '#ft-window-fails', '#ft-window-secs', '#ft-cap', '#ft-burst', '#ft-retry-after'];
  const ftSnapshot = () => ftFields.map((id) => {
    const el = $(id);
    return el && 'checked' in el && el.type === 'checkbox' ? String(el.checked) : String(el ? el.value : '');
  }).join('|');
  const ftBaseline = ftSnapshot();
  const ftMarkDirty = () => {
    const dirty = $('#ft-dirty');
    if (dirty) dirty.hidden = ftSnapshot() === ftBaseline;
  };
  ftFields.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', ftMarkDirty);
  });
  $('#ft-save').addEventListener('click', async () => {
    const num = (id) => Number($(id).value);
    const payload = {
      circuitBreakerThreshold: num('#ft-threshold'),
      circuitBreakerRecoveryMs: num('#ft-recovery') * 1000,
      breakerSelfCancelMs: num('#ft-self-cancel') * 1000,
      windowFailures: num('#ft-window-fails'),
      windowSeconds: num('#ft-window-secs'),
      retryAfterCapMs: num('#ft-cap') * 1000,
      burstFailoverEnabled: $('#ft-burst').checked,
      honorRetryAfter: $('#ft-retry-after').checked,
    };
    const diffBits = [];
    const prev = state.failoverTuning || {};
    const fmtS = (ms) => `${Math.round(ms / 1000)}s`;
    if (payload.circuitBreakerThreshold !== prev.circuitBreakerThreshold) diffBits.push(`Streak ${prev.circuitBreakerThreshold}→${payload.circuitBreakerThreshold}`);
    if (payload.windowFailures !== prev.windowFailures || payload.windowSeconds !== prev.windowSeconds) diffBits.push(`Window ${prev.windowFailures}/${prev.windowSeconds}s→${payload.windowFailures}/${payload.windowSeconds}s`);
    if (payload.circuitBreakerRecoveryMs !== prev.circuitBreakerRecoveryMs) diffBits.push(`Recovery ${fmtS(prev.circuitBreakerRecoveryMs)}→${fmtS(payload.circuitBreakerRecoveryMs)}`);
    if (payload.breakerSelfCancelMs !== prev.breakerSelfCancelMs) diffBits.push(`Self-cancel ${fmtS(prev.breakerSelfCancelMs)}→${fmtS(payload.breakerSelfCancelMs)}`);
    if (payload.retryAfterCapMs !== prev.retryAfterCapMs) diffBits.push(`Cap ${fmtS(prev.retryAfterCapMs)}→${fmtS(payload.retryAfterCapMs)}`);
    if (payload.burstFailoverEnabled !== prev.burstFailoverEnabled) diffBits.push(`Burst-failover ${payload.burstFailoverEnabled ? 'on' : 'off'}`);
    if (payload.honorRetryAfter !== prev.honorRetryAfter) diffBits.push(`Honor Retry-After ${payload.honorRetryAfter ? 'on' : 'off'}`);
    if (diffBits.length === 0) {
      toast('Already at these values — nothing saved', 'info');
      return;
    }
    try {
      state.failoverTuning = await api.setFailoverTuning(payload);
      toast(`Failover tuning saved: ${diffBits.join(' · ')}`, 'success');
      renderFailoverTuning();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------------------
// Page: Logs (virtualized with stable scroll, optional pagination)
// ---------------------------------------------------------------------------

const LOG_ROW_H = 32;
const LOG_OVERSCAN = 8;
let logRenderPending = false;
let logFollow = true;
let logMode = 'virtualized';
let logPage = 1;
let logPageSize = 250;

function getFilteredLogs() {
  const search = state.logFilter.search.trim().toLowerCase();
  const level = state.logFilter.level;
  const provider = state.logFilter.provider;
  // Stored oldest-first; display newest-first.
  const chronological = [...state.archivedLogs, ...state.recentLogs];
  let filtered;
  if (!search && !level && !provider) {
    filtered = chronological;
  } else {
    filtered = chronological.filter((e) => {
      if (level === 'quota') {
        if (!e.meta?.quotaError) return false;
      } else if (level) {
        if ((e.level || 'info') !== level) return false;
      }
      if (provider && (e.meta?.upstream || '') !== provider) return false;
      if (!search) return true;
      const m = e.meta || {};
      const haystack = [
        e.message || '',
        m.path || '',
        m.method || '',
        m.keyAlias || '',
        m.model || '',
        m.routeReason || '',
        m.statusCode || '',
        m.upstream || '',
        m.quotaError?.message || '',
      ].join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }
  // Reverse for display: latest at index 0, oldest at the bottom.
  return filtered.slice().reverse();
}

function ensureLogRender() {
  if (logRenderPending) return;
  logRenderPending = true;
  requestAnimationFrame(() => {
    logRenderPending = false;
    renderLogs();
  });
}

const scheduleLogRender = rAFThrottle(ensureLogRender);

function renderLogRowHTML(entry, idx) {
  const m = entry.meta || {};
  const status = m.statusCode || '';
  const statusClass = status >= 500 ? 'status-5xx'
    : status >= 400 ? 'status-4xx'
    : status >= 300 ? 'status-3xx'
    : status >= 200 ? 'status-2xx' : '';
  const tokens = m.tokens;
  const tokenText = tokens
    ? `I:${tokens.input || 0} O:${tokens.output || 0} CR:${tokens.cacheRead || 0} CW:${tokens.cacheWrite || 0} R:${tokens.reasoning || 0}`
    : '';
  const isQuota = Boolean(m.quotaError);
  const quotaPill = isQuota ? ' <span class="quota-pill">QUOTA</span>' : '';
  const expanded = state.expandedLogId === entry.__id;
  const top = idx * LOG_ROW_H;
  const expandedClass = expanded ? ' expanded' : '';
  const quotaClass = isQuota ? ' is-quota' : '';
  const upstream = m.upstream || '';
  const upstreamPill = upstream
    ? ` <span class="upstream-pill upstream-${escapeHtml(upstream)}" title="Routed to ${upstream === 'zen' ? 'OpenCode Zen (free tier)' : 'OpenCode Go (paid)'}">${upstream.toUpperCase()}</span>`
    : '';
  return `
    <div class="log-row${expandedClass}${quotaClass}" data-log-id="${entry.__id}" data-log-idx="${idx}" style="top:${top}px;">
      <span class="cell time">${escapeHtml(fmtTime(entry.timestamp))}</span>
      <span class="cell level level-${escapeHtml(entry.level || 'info')}">${escapeHtml((entry.level || 'info').toUpperCase())}${quotaPill}${upstreamPill}</span>
      <span class="cell method">${escapeHtml(m.method || '')}</span>
      <span class="cell path" title="${escapeHtml(m.path || '')}">${escapeHtml(m.path || '')}</span>
      <span class="cell status ${statusClass}">${escapeHtml(status ? String(status) : '')}</span>
      <span class="cell key">${escapeHtml(m.keyAlias || '')}</span>
      <span class="cell model" title="${escapeHtml(m.model || '')}">${escapeHtml(m.model || '')}</span>
      <span class="cell reason" title="${escapeHtml(m.routeReason || entry.message || '')}">${escapeHtml(m.routeReason || entry.message || '')}</span>
      <span class="cell tokens">${escapeHtml(tokenText)}</span>
      ${m.cost != null
        ? `<span class="cell cost ${m.costEstimated ? 'is-estimated' : ''}" title="${escapeHtml(m.costEstimated ? 'Estimated from published rate card — may not reflect the actual cost.' : 'Actual cost returned by the upstream provider.')}">${m.costEstimated ? '~' : ''}${escapeHtml(fmtCurrency(m.cost))}</span>`
        : '<span class="cell cost" title="Cost not reported by the upstream and no rate card entry for this model.">—</span>'}
      ${expanded ? `<div class="log-detail">${escapeHtml(JSON.stringify(entry, null, 2))}</div>` : ''}
    </div>
  `;
}

function renderLogs() {
  const body = $('#log-body');
  const rowsHost = $('#log-rows');
  const emptyEl = $('#log-empty');
  const paginationEl = $('#log-pagination');
  if (!body || !rowsHost) return;

  const all = getFilteredLogs();
  const totalAll = state.archivedLogs.length + state.recentLogs.length;
  const modePaginated = logMode === 'paginated';

  // Update footer counts and mode
  $('#logs-count').textContent = `${fmtNumber(all.length)} of ${fmtNumber(totalAll)} entries`;
  $('#logs-status').textContent = state.paused ? 'Paused (buffered)' : 'Live';
  if (paginationEl) paginationEl.style.display = modePaginated ? 'flex' : 'none';

  if (!all.length) {
    rowsHost.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    rowsHost.style.height = '0px';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  if (modePaginated) {
    const pageSize = logPageSize;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    if (logPage > totalPages) logPage = totalPages;
    if (logPage < 1) logPage = 1;
    const start = (logPage - 1) * pageSize;
    const end = Math.min(all.length, start + pageSize);
    const slice = all.slice(start, end);
    rowsHost.style.height = (slice.length * LOG_ROW_H) + 'px';
    rowsHost.innerHTML = slice.map((entry, i) => renderLogRowHTML(entry, start + i)).join('');
    const info = $('#log-page-info');
    if (info) info.textContent = `Page ${logPage} of ${totalPages} · ${fmtNumber(start + 1)}–${fmtNumber(end)} of ${fmtNumber(all.length)}`;
    // Reset scroll to top of page on first render
    if (body.dataset.paginatedPage !== String(logPage)) {
      body.scrollTop = 0;
      body.dataset.paginatedPage = String(logPage);
    }
    return;
  }

  // Virtualized rendering
  body.dataset.paginatedPage = '';
  const viewportH = body.clientHeight || 480;
  const totalH = all.length * LOG_ROW_H;
  rowsHost.style.height = totalH + 'px';
  const scrollTop = body.scrollTop;
  const first = Math.max(0, Math.floor(scrollTop / LOG_ROW_H) - LOG_OVERSCAN);
  const visible = Math.ceil(viewportH / LOG_ROW_H) + LOG_OVERSCAN * 2;
  const last = Math.min(all.length, first + visible);
  const slice = all.slice(first, last);
  rowsHost.innerHTML = slice.map((entry, i) => renderLogRowHTML(entry, first + i)).join('');
}

function scrollLogToTop() {
  const body = $('#log-body');
  if (!body) return;
  body.scrollTop = 0;
}

function initLogsToolbar() {
  $('#logs-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#logs-pause').textContent = state.paused ? 'Resume' : 'Pause';
    if (!state.paused) {
      logFollow = true;
      if (state.pausedBuffer.length) {
        for (const e of state.pausedBuffer) ingestLog(e, { initial: true });
        state.pausedBuffer = [];
      }
      if (logMode === 'virtualized') scrollLogToTop();
    }
    ensureLogRender();
  });
  $('#logs-clear').addEventListener('click', () => {
    state.archivedLogs = [];
    state.recentLogs = [];
    state.expandedLogId = null;
    logPage = 1;
    logFollow = true;
    ensureLogRender();
  });
  $('#logs-download').addEventListener('click', () => {
    const all = [...state.archivedLogs, ...state.recentLogs];
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `router-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#log-body').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    const id = row.dataset.logId;
    state.expandedLogId = state.expandedLogId === id ? null : id;
    ensureLogRender();
  });
  // Stable scroll handler: only update the follow flag and schedule a render.
  // Never modify scrollTop here (that was the source of the scroll-event cycle).
  let scrollRaf = 0;
  $('#log-body').addEventListener('scroll', () => {
    if (logMode !== 'virtualized') return;
    const el = $('#log-body');
    if (!el) return;
    // Latest logs are at the top, so "following" means staying at scrollTop near 0.
    const atTop = el.scrollTop <= 40;
    logFollow = atTop;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      ensureLogRender();
    });
  }, { passive: true });
  // Mode toggle (virtualized vs paginated)
  $$('#logs-mode .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#logs-mode .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      logMode = chip.dataset.mode || 'virtualized';
      logPage = 1;
      logFollow = true;
      const body = $('#log-body');
      if (body) {
        body.scrollTop = 0;
        body.dataset.paginatedPage = '';
      }
      ensureLogRender();
    });
  });
  // Pagination controls
  $('#log-page-first').addEventListener('click', () => { logPage = 1; ensureLogRender(); });
  $('#log-page-prev').addEventListener('click', () => { logPage = Math.max(1, logPage - 1); ensureLogRender(); });
  $('#log-page-next').addEventListener('click', () => { logPage = logPage + 1; ensureLogRender(); });
  $('#log-page-last').addEventListener('click', () => {
    const all = getFilteredLogs();
    logPage = Math.max(1, Math.ceil(all.length / logPageSize));
    ensureLogRender();
  });
  $('#log-page-size').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v > 0) {
      logPageSize = v;
      logPage = 1;
      ensureLogRender();
    }
  });
  // Right-click context menu
  const ctxMenu = $('#ctx-menu');
  $('#log-body').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) { ctxMenu.style.display = 'none'; return; }
    e.preventDefault();
    const idx = parseInt(row.dataset.logIdx, 10);
    const entry = getFilteredLogs()[idx];
    if (!entry) return;
    const m = entry.meta || {};
    ctxMenu.innerHTML =
      `<div class="ctx-item" data-copy="${escapeHtml(m.model || '')}">Copy model</div>` +
      `<div class="ctx-item" data-copy="${escapeHtml(m.path || '')}">Copy path</div>` +
      `<div class="ctx-item" data-copy="${escapeHtml(m.keyAlias || '')}">Copy key alias</div>` +
      `<div class="ctx-sep"></div>` +
      `<div class="ctx-item" data-copy="${escapeHtml(JSON.stringify(entry))}">Copy full entry</div>`;
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
    ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
  });
  ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    navigator.clipboard.writeText(item.dataset.copy).then(() => toast('Copied', 'success')).catch(() => {});
    ctxMenu.style.display = 'none';
  });
  document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ctxMenu.style.display = 'none';
  });
}

function initSearch() {
  const input = $('#logs-search');
  if (!input) return;
  const handler = debounce(() => {
    state.logFilter.search = input.value;
    ensureLogRender();
  }, 120);
  input.addEventListener('input', handler);

  // Level filter chips
  $$('#logs-levels .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#logs-levels .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.logFilter.level = chip.dataset.level || '';
      ensureLogRender();
    });
  });

  // Provider filter chips (Go / Zen / All)
  $$('#logs-provider .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#logs-provider .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.logFilter.provider = chip.dataset.provider || '';
      ensureLogRender();
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Tokens
// ---------------------------------------------------------------------------

const TOKENS_WINDOWS = {
  3600000: { bucketMs: 60_000, label: 'Last 1h', fmtTick: 'time', tickIntervalMs: 300_000 },
  21600000: { bucketMs: 5 * 60_000, label: 'Last 6h', fmtTick: 'time', tickIntervalMs: 1_800_000 },
  86400000: { bucketMs: 15 * 60_000, label: 'Last 24h', fmtTick: 'datetime', tickIntervalMs: 3_600_000 },
  604800000: { bucketMs: 60 * 60_000, label: 'Last 7d', fmtTick: 'datetime', tickIntervalMs: 43_200_000 },
  2592000000: { bucketMs: 6 * 60 * 60_000, label: 'Last 30d', fmtTick: 'date', tickIntervalMs: 86_400_000 },
};

const TOKENS_CATEGORIES = [
  { key: 'input', label: 'Input', color: 'var(--accent)' },
  { key: 'output', label: 'Output', color: 'var(--green)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--purple)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--yellow)' },
  { key: 'reasoning', label: 'Reasoning', color: 'var(--red)' },
];

const tokensState = {
  windowMs: 86_400_000,
  pending: false,
};

function getTokenLogsInWindow(windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  const out = [];
  for (const entry of state.archivedLogs) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    if (ts >= cutoff) out.push(entry);
  }
  for (const entry of state.recentLogs) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    if (ts >= cutoff) out.push(entry);
  }
  return out;
}

function bucketize(entries, bucketMs, rangeStart, rangeEnd) {
  const hasRange = rangeStart !== undefined && rangeEnd !== undefined;
  if (!entries.length && !hasRange) return { buckets: [], tMin: 0, tMax: 0 };
  let tMin = rangeStart ?? Infinity;
  let tMax = rangeEnd ?? -Infinity;
  if (!hasRange) {
    for (const e of entries) {
      const ts = new Date(e.timestamp).getTime();
      if (ts < tMin) tMin = ts;
      if (ts > tMax) tMax = ts;
    }
    if (!Number.isFinite(tMin)) return { buckets: [], tMin: 0, tMax: 0 };
  }
  const firstBucket = Math.floor(tMin / bucketMs) * bucketMs;
  const lastBucket = Math.floor((tMax - 1) / bucketMs) * bucketMs;
  const numBuckets = Math.max(1, Math.floor((lastBucket - firstBucket) / bucketMs) + 1);
  const buckets = [];
  for (let i = 0; i < numBuckets; i++) {
    buckets.push({
      t: firstBucket + i * bucketMs,
      byCategory: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      byModel: new Map(),
      byKey: new Map(),
      cost: 0,
      requests: 0,
    });
  }
  const indexFor = (ts) => Math.floor((ts - firstBucket) / bucketMs);
  for (const e of entries) {
    const ts = new Date(e.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const m = e.meta || {};
    const tokens = m.tokens || null;
    const idx = indexFor(ts);
    if (idx < 0 || idx >= buckets.length) continue;
    const b = buckets[idx];
    b.requests += 1;
    if (m.model) {
      let mb = b.byModel.get(m.model);
      if (!mb) { mb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0 }; b.byModel.set(m.model, mb); }
      mb.requests += 1;
    }
    if (m.keyAlias) {
      let kb = b.byKey.get(m.keyAlias);
      if (!kb) { kb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0 }; b.byKey.set(m.keyAlias, kb); }
      kb.requests += 1;
    }
    if (tokens) {
      b.byCategory.input += tokens.input || 0;
      b.byCategory.output += tokens.output || 0;
      b.byCategory.cacheRead += tokens.cacheRead || 0;
      b.byCategory.cacheWrite += tokens.cacheWrite || 0;
      b.byCategory.reasoning += tokens.reasoning || 0;
      if (typeof m.cost === 'number' && Number.isFinite(m.cost)) b.cost += m.cost;
      if (m.model) {
        const mb = b.byModel.get(m.model);
        if (mb) {
          mb.input += tokens.input || 0;
          mb.output += tokens.output || 0;
          mb.cacheRead += tokens.cacheRead || 0;
          mb.cacheWrite += tokens.cacheWrite || 0;
          mb.reasoning += tokens.reasoning || 0;
          if (typeof m.cost === 'number' && Number.isFinite(m.cost)) mb.cost += m.cost;
        }
      }
      if (m.keyAlias) {
        const kb = b.byKey.get(m.keyAlias);
        if (kb) {
          kb.input += tokens.input || 0;
          kb.output += tokens.output || 0;
          kb.cacheRead += tokens.cacheRead || 0;
          kb.cacheWrite += tokens.cacheWrite || 0;
          kb.reasoning += tokens.reasoning || 0;
          if (typeof m.cost === 'number' && Number.isFinite(m.cost)) kb.cost += m.cost;
        }
      }
    }
  }
  return { buckets, tMin: firstBucket, tMax: lastBucket + bucketMs };
}

function aggregateAll(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0 };
  const byModel = new Map();
  for (const e of entries) {
    const m = e.meta || {};
    const t = m.tokens;
    totals.requests += 1;
    if (t) {
      totals.input += t.input || 0;
      totals.output += t.output || 0;
      totals.cacheRead += t.cacheRead || 0;
      totals.cacheWrite += t.cacheWrite || 0;
      totals.reasoning += t.reasoning || 0;
      if (typeof m.cost === 'number' && Number.isFinite(m.cost)) totals.cost += m.cost;
    }
    if (!m.model) continue;
    let mb = byModel.get(m.model);
    if (!mb) { mb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0, errors: 0 }; byModel.set(m.model, mb); }
    mb.requests += 1;
    // Error = upstream 4xx/5xx or transport failure (statusCode 0). Success =
    // 2xx only. Drives the donut's per-model error-rate column (spill predictor).
    if (typeof m.statusCode !== 'number' || m.statusCode >= 400) mb.errors += 1;
    if (t) {
      mb.input += t.input || 0;
      mb.output += t.output || 0;
      mb.cacheRead += t.cacheRead || 0;
      mb.cacheWrite += t.cacheWrite || 0;
      mb.reasoning += t.reasoning || 0;
      if (typeof m.cost === 'number' && Number.isFinite(m.cost)) mb.cost += m.cost;
    }
  }
  return { totals, byModel };
}

function renderTokensKpis(totals) {
  const kpis = [
    { label: 'Requests', value: fmtTokens(totals.requests) },
    { label: 'Total tokens', value: fmtTokens(totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning) },
    { label: 'Cache read', value: fmtTokens(totals.cacheRead), accent: 'purple' },
    { label: 'Cache write', value: fmtTokens(totals.cacheWrite), accent: 'yellow' },
    { label: 'Observed cost', value: fmtCurrency(totals.cost), accent: 'accent' },
  ];
  $('#tokens-kpis').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <span class="kpi-label">${escapeHtml(k.label)}</span>
      <span class="kpi-value ${k.accent || ''}">${escapeHtml(String(k.value))}</span>
    </div>
  `).join('');
}

function renderTokensSharedChart(buckets, config) {
  const host = $('#tokens-shared-chart');
  if (!host) return;
  if (!buckets.length) {
    host.innerHTML = `<div style="height: 220px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 12px; font-family: var(--font-mono);">No log entries with token usage in this window.</div>`;
    return;
  }
  if (buckets.length === 1) {
    const b = buckets[0];
    const stackTop = TOKENS_CATEGORIES.reduce((s, c) => s + (b.byCategory[c.key] || 0), 0);
    host.innerHTML = `<div style="height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; font-family: var(--font-mono);">
      <div>Single bucket: ${fmtTokens(stackTop)} tokens in this window</div>
      <div style="display: flex; gap: 12px; font-size: 11px;">
        ${TOKENS_CATEGORIES.map((c) => `<span><span class="swatch" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.color};margin-right:4px;vertical-align:middle;"></span>${escapeHtml(c.label)} ${fmtTokens(b.byCategory[c.key] || 0)}</span>`).join('')}
      </div>
    </div>`;
    return;
  }
  host.innerHTML = stackedAreaChartSvg(buckets, { width: 1080, height: 240, padding: { top: 12, right: 12, bottom: 28, left: 50 }, bucketMs: config.bucketMs, tickIntervalMs: config.tickIntervalMs });
}

function stackedAreaChartSvg(buckets, opts) {
  const { width, height, padding, bucketMs, tickIntervalMs } = opts;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const tMin = buckets[0].t;
  const tMax = buckets[buckets.length - 1].t + (bucketMs || 1);
  const span = Math.max(1, tMax - tMin);
  const x = (t) => padding.left + ((t - tMin) / span) * innerW;

  // Compute stack totals per bucket to find max.
  const stackTop = buckets.map((b) => {
    let acc = 0;
    for (const c of TOKENS_CATEGORIES) acc += b.byCategory[c.key] || 0;
    return acc;
  });
  const yMax = Math.max(1, ...stackTop);
  const y = (v) => padding.top + innerH - (v / yMax) * innerH;

  // Horizontal grid lines (y-axis)
  const hGrid = [];
  for (let i = 0; i <= 4; i++) {
    const yy = padding.top + (innerH / 4) * i;
    hGrid.push(`<line x1="${padding.left}" y1="${yy}" x2="${width - padding.right}" y2="${yy}"/>`);
  }

  // X-axis ticks
  const ticks = [];
  if (tickIntervalMs && tickIntervalMs > 0) {
    const firstTick = Math.ceil(tMin / tickIntervalMs) * tickIntervalMs;
    for (let t = firstTick; t <= tMax; t += tickIntervalMs) {
      ticks.push(t);
    }
  }

  // Tick formatter
  const tickFmt = (t) => {
    const d = new Date(t);
    if (TOKENS_WINDOWS[tokensState.windowMs]?.fmtTick === 'date') {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    if (TOKENS_WINDOWS[tokensState.windowMs]?.fmtTick === 'datetime') {
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // Determine label spacing to avoid overlap
  const labelMinPx = 80;
  const maxLabels = Math.max(1, Math.floor(innerW / labelMinPx));
  const labelStep = Math.max(1, Math.ceil(ticks.length / maxLabels));

  // Vertical grid lines + x-axis labels
  const vGridAndLabels = ticks.map((t, i) => {
    const xx = x(t).toFixed(1);
    const showLabel = i % labelStep === 0 || i === ticks.length - 1;
    return `
      <line x1="${xx}" y1="${padding.top}" x2="${xx}" y2="${padding.top + innerH}" class="grid-v"/>
      ${showLabel ? `<text x="${xx}" y="${height - 8}" text-anchor="middle" font-size="10" class="axis-tick">${escapeHtml(tickFmt(t))}</text>` : ''}
    `;
  }).join('');

  // Build stacked areas. For each category, draw a path from the bottom of
  // that category to the top, then back along the top of the previous one.
  const areaPaths = [];
  const cumUpper = TOKENS_CATEGORIES.map(() => new Array(buckets.length).fill(0));
  const cumLower = TOKENS_CATEGORIES.map(() => new Array(buckets.length).fill(0));
  for (let bi = 0; bi < buckets.length; bi++) {
    let acc = 0;
    for (let ci = 0; ci < TOKENS_CATEGORIES.length; ci++) {
      cumLower[ci][bi] = acc;
      acc += buckets[bi].byCategory[TOKENS_CATEGORIES[ci].key] || 0;
      cumUpper[ci][bi] = acc;
    }
  }
  for (let ci = 0; ci < TOKENS_CATEGORIES.length; ci++) {
    const cat = TOKENS_CATEGORIES[ci];
    const parts = [];
    for (let i = 0; i < buckets.length; i++) {
      const xt = x(buckets[i].t).toFixed(1);
      const yt = y(cumUpper[ci][i]).toFixed(1);
      parts.push((i === 0 ? 'M' : 'L') + xt + ',' + yt);
    }
    for (let i = buckets.length - 1; i >= 0; i--) {
      const xt = x(buckets[i].t).toFixed(1);
      const yb = y(cumLower[ci][i]).toFixed(1);
      parts.push('L' + xt + ',' + yb);
    }
    const path = parts.join(' ') + ' Z';
    areaPaths.push(`<path d="${path}" fill="${cat.color}" fill-opacity="0.55" stroke="${cat.color}" stroke-opacity="0.5" stroke-width="0.5"/>`);
  }

  // Hover probes: one transparent rect per bucket, full plot height. Same
  // pattern as the Overview throughput chart — values are per-bucket
  // aggregates (whatever bucketMs the window uses), not per-request.
  const probeW = buckets.length > 1 ? Math.max(8, (x(buckets[1].t) - x(buckets[0].t))) : innerW;
  const probeRects = buckets.map((b) => {
    const rows = TOKENS_CATEGORIES.map((c) => `${c.label}: ${fmtTokens(b.byCategory[c.key] || 0)}`).join(' · ');
    const tot = fmtTokens(TOKENS_CATEGORIES.reduce((s, c) => s + (b.byCategory[c.key] || 0), 0));
    return `<rect x="${(x(b.t) - probeW / 2).toFixed(1)}" y="${padding.top}" width="${probeW.toFixed(1)}" height="${innerH}" fill="transparent"><title>${escapeHtml(tickFmt(b.t))} — total ${tot} (${rows})</title></rect>`;
  }).join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
      <g class="grid">${hGrid.join('')}</g>
      <g class="grid-v">${vGridAndLabels}</g>
      <g class="axis">
        <text x="4" y="${padding.top + 8}">${fmtTokens(yMax)}</text>
        <text x="4" y="${padding.top + innerH}">0</text>
      </g>
      ${areaPaths.join('')}
      ${probeRects}
    </svg>
  `;
}

function renderTokensModelsTable(byModel) {
  const host = $('#tokens-models-table');
  if (!host) return;
  const rows = [...byModel.entries()].map(([model, agg]) => {
    const total = agg.input + agg.output + agg.cacheRead + agg.cacheWrite + agg.reasoning;
    return { model, agg, total };
  }).sort((a, b) => b.total - a.total);
  if (rows.length === 0) {
    host.innerHTML = `<div class="empty-state"><strong>No model data</strong>Token-usage log entries with a model field will appear here.</div>`;
    return;
  }
  const head = `
    <div class="tr">
      <div class="th">Model</div>
      <div class="th" style="text-align: right;">Req</div>
      <div class="th" style="text-align: right;">Input</div>
      <div class="th" style="text-align: right;">Output</div>
      <div class="th" style="text-align: right;">CR</div>
      <div class="th" style="text-align: right;">CW</div>
      <div class="th" style="text-align: right;">Reasoning</div>
      <div class="th" style="text-align: right;">Total</div>
      <div class="th" style="text-align: right;">Cost</div>
      <div class="th" style="min-width: 100px;">Share</div>
    </div>
  `;
  const body = rows.map(({ model, agg, total }) => {
    const pct = (v) => total > 0 ? (v / total) * 100 : 0;
    return `
      <div class="tr">
        <div class="td td-model">${escapeHtml(model)}</div>
        <div class="td td-num" style="text-align: right;">${fmtNumber(agg.requests)}</div>
        <div class="td td-num" style="text-align: right;">${fmtTokens(agg.input)}</div>
        <div class="td td-num" style="text-align: right;">${fmtTokens(agg.output)}</div>
        <div class="td td-num" style="text-align: right;">${fmtTokens(agg.cacheRead)}</div>
        <div class="td td-num" style="text-align: right;">${fmtTokens(agg.cacheWrite)}</div>
        <div class="td td-num" style="text-align: right;">${fmtTokens(agg.reasoning)}</div>
        <div class="td td-num" style="text-align: right;"><strong>${fmtTokens(total)}</strong></div>
        <div class="td td-num" style="text-align: right;">${fmtCurrency(agg.cost)}</div>
        <div class="td"><div class="tokens-bar" title="Input / Output / CR / CW / R">
          <span class="seg-input" style="width:${pct(agg.input).toFixed(2)}%"></span>
          <span class="seg-output" style="width:${pct(agg.output).toFixed(2)}%"></span>
          <span class="seg-cr" style="width:${pct(agg.cacheRead).toFixed(2)}%"></span>
          <span class="seg-cw" style="width:${pct(agg.cacheWrite).toFixed(2)}%"></span>
          <span class="seg-r" style="width:${pct(agg.reasoning).toFixed(2)}%"></span>
        </div></div>
      </div>
    `;
  }).join('');
  host.innerHTML = head + body;
}

function renderTokensModelSeries(buckets) {
  const host = $('#tokens-model-series');
  if (!host) return;
  // Aggregate by model across all buckets to find which models are worth showing.
  const modelTotals = new Map();
  for (const b of buckets) {
    for (const [model, agg] of b.byModel) {
      const cur = modelTotals.get(model) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0 };
      cur.input += agg.input; cur.output += agg.output; cur.cacheRead += agg.cacheRead; cur.cacheWrite += agg.cacheWrite; cur.reasoning += agg.reasoning; cur.requests += agg.requests; cur.cost += agg.cost;
      modelTotals.set(model, cur);
    }
  }
  if (modelTotals.size === 0) {
    host.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><strong>No model activity in this window</strong>Try a wider time window or wait for new traffic.</div>`;
    return;
  }
  const sorted = [...modelTotals.entries()].sort((a, b) => {
    const sa = a[1].input + a[1].output + a[1].cacheRead + a[1].cacheWrite + a[1].reasoning;
    const sb = b[1].input + b[1].output + b[1].cacheRead + b[1].cacheWrite + b[1].reasoning;
    return sb - sa;
  }).filter(([model]) => {
    const vm = state.visibleModels;
    return !vm || !vm.length || vm.includes(model);
  });
  host.innerHTML = sorted.map(([model, agg]) => {
    const total = agg.input + agg.output + agg.cacheRead + agg.cacheWrite + agg.reasoning;
    const cleanSeries = TOKENS_CATEGORIES.map((cat) => ({
      key: cat.key, label: cat.label, color: cat.color,
      points: buckets.map((b) => {
        const mb = b.byModel.get(model);
        return { t: b.t, v: mb ? (mb[cat.key] || 0) : 0 };
      }),
    }));
    return `
      <div class="tokens-mini">
        <div class="tokens-mini-head">
          <span class="tokens-mini-name">${escapeHtml(model)}</span>
          <span class="tokens-mini-total">${fmtTokens(total)} tok</span>
        </div>
        ${miniStackedAreaSvg(cleanSeries, buckets)}
        <div class="tokens-mini-legend">
          ${TOKENS_CATEGORIES.map((c) => `<span class="item"><span class="swatch" style="background:${c.color};"></span>${escapeHtml(c.label)} <strong style="color: var(--text-secondary); margin-left: 2px;">${fmtTokens(agg[c.key] || 0)}</strong></span>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function miniStackedAreaSvg(series, buckets) {
  if (!buckets.length) {
    return `<svg class="tokens-mini-svg" viewBox="0 0 360 100" preserveAspectRatio="xMidYMid meet"></svg>`;
  }
  const width = 360, height = 100, padTop = 4, padBottom = 20, padX = 2;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const tMin = buckets[0].t;
  const bucketMs = buckets.length > 1 ? buckets[1].t - buckets[0].t : 1;
  const tMax = buckets[buckets.length - 1].t + bucketMs;
  const span = Math.max(1, tMax - tMin);
  const x = (t) => padX + ((t - tMin) / span) * innerW;
  // Per-bucket stack top
  const stackTops = buckets.map((b, i) => series.reduce((s, s2) => s + (s2.points[i]?.v || 0), 0));
  const yMax = Math.max(1, ...stackTops);
  const y = (v) => padTop + innerH - (v / yMax) * innerH;

  // Generate x-axis ticks (about 6 evenly spaced)
  const tickIntervalMini = Math.max(1, Math.floor(bucketMs * Math.max(1, Math.ceil(buckets.length / 6))));
  const miniTicks = [];
  {
    const firstTick = Math.ceil(tMin / tickIntervalMini) * tickIntervalMini;
    for (let t = firstTick; t <= tMax; t += tickIntervalMini) {
      miniTicks.push(t);
    }
  }
  const miniLabelStep = Math.max(1, Math.ceil(miniTicks.length / 6));
  const miniTickMarkup = miniTicks.map((t, i) => {
    const xx = x(t).toFixed(1);
    const showLabel = i % miniLabelStep === 0 || i === miniTicks.length - 1;
    const d = new Date(t);
    const label = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `
      <line x1="${xx}" y1="${padTop + innerH}" x2="${xx}" y2="${padTop + innerH + 4}" stroke="var(--border)"/>
      ${showLabel ? `<text x="${xx}" y="${height - 6}" text-anchor="middle" font-size="9" fill="var(--text-secondary)" class="axis-tick">${escapeHtml(label)}</text>` : ''}
    `;
  }).join('');

  // Build cumulative
  const cumUpper = series.map(() => new Array(buckets.length).fill(0));
  const cumLower = series.map(() => new Array(buckets.length).fill(0));
  for (let bi = 0; bi < buckets.length; bi++) {
    let acc = 0;
    for (let si = 0; si < series.length; si++) {
      cumLower[si][bi] = acc;
      acc += series[si].points[bi]?.v || 0;
      cumUpper[si][bi] = acc;
    }
  }
  const paths = series.map((s, si) => {
    const parts = [];
    for (let i = 0; i < buckets.length; i++) {
      const xt = x(buckets[i].t).toFixed(1);
      const yt = y(cumUpper[si][i]).toFixed(1);
      parts.push((i === 0 ? 'M' : 'L') + xt + ',' + yt);
    }
    for (let i = buckets.length - 1; i >= 0; i--) {
      const xt = x(buckets[i].t).toFixed(1);
      const yb = y(cumLower[si][i]).toFixed(1);
      parts.push('L' + xt + ',' + yb);
    }
    return `<path d="${parts.join(' ')} Z" fill="${s.color}" fill-opacity="0.55" stroke="${s.color}" stroke-opacity="0.4" stroke-width="0.5"/>`;
  }).join('');
  // Hover probes: one transparent rect per bucket, time + per-category values.
  // Same pattern as the main Tokens chart and Overview throughput.
  const miniProbeW = buckets.length > 1 ? Math.max(6, (x(buckets[1].t) - x(buckets[0].t))) : innerW;
  const miniFmtT = (t) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const miniProbes = buckets.map((b, bi) => {
    const rows = series.map((s) => `${s.label}: ${fmtTokens(s.points[bi]?.v || 0)}`).join(' · ');
    const tot = fmtTokens(series.reduce((s, se) => s + (se.points[bi]?.v || 0), 0));
    return `<rect x="${(x(b.t) - miniProbeW / 2).toFixed(1)}" y="${padTop}" width="${miniProbeW.toFixed(1)}" height="${innerH}" fill="transparent"><title>${escapeHtml(miniFmtT(b.t))} — total ${tot} (${rows})</title></rect>`;
  }).join('');
  return `<svg class="tokens-mini-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${miniTickMarkup}${paths}${miniProbes}</svg>`;
}

function renderTokensKeySeries(buckets) {
  const host = $('#tokens-key-series');
  if (!host) return;
  const keyTotals = new Map();
  for (const b of buckets) {
    for (const [key, agg] of b.byKey) {
      const cur = keyTotals.get(key) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, cost: 0 };
      cur.input += agg.input; cur.output += agg.output; cur.cacheRead += agg.cacheRead; cur.cacheWrite += agg.cacheWrite; cur.reasoning += agg.reasoning; cur.requests += agg.requests; cur.cost += agg.cost;
      keyTotals.set(key, cur);
    }
  }
  if (keyTotals.size === 0) {
    host.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><strong>No key activity in this window</strong></div>`;
    return;
  }
  const sorted = [...keyTotals.entries()].sort((a, b) => {
    const sa = a[1].input + a[1].output + a[1].cacheRead + a[1].cacheWrite + a[1].reasoning;
    const sb = b[1].input + b[1].output + b[1].cacheRead + b[1].cacheWrite + b[1].reasoning;
    return sb - sa;
  });
  host.innerHTML = sorted.map(([key, agg]) => {
    const total = agg.input + agg.output + agg.cacheRead + agg.cacheWrite + agg.reasoning;
    const series = TOKENS_CATEGORIES.map((cat) => ({
      key: cat.key, label: cat.label, color: cat.color,
      points: buckets.map((b) => {
        const kb = b.byKey.get(key);
        return { t: b.t, v: kb ? (kb[cat.key] || 0) : 0 };
      }),
    }));
    return `
      <div class="tokens-mini">
        <div class="tokens-mini-head">
          <span class="tokens-mini-name">${escapeHtml(key)}</span>
          <span class="tokens-mini-total">${fmtTokens(total)} tok</span>
        </div>
        ${miniStackedAreaSvg(series, buckets)}
        <div class="tokens-mini-legend">
          ${TOKENS_CATEGORIES.map((c) => `<span class="item"><span class="swatch" style="background:${c.color};"></span>${escapeHtml(c.label)} <strong style="color: var(--text-secondary); margin-left: 2px;">${fmtTokens(agg[c.key] || 0)}</strong></span>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderTokens() {
  const windowMs = tokensState.windowMs;
  const config = TOKENS_WINDOWS[windowMs] || TOKENS_WINDOWS[86400000];
  const now = Date.now();
  const cutoff = now - windowMs;
  const entries = getTokenLogsInWindow(windowMs, now);
  const { totals, byModel } = aggregateAll(entries);
  const { buckets } = bucketize(entries, config.bucketMs, cutoff, now);

  // Filter by visible models if set
  const vm = state.visibleModels;
  if (vm && vm.length) {
    for (const [model] of byModel) {
      if (!vm.includes(model)) byModel.delete(model);
    }
  }

  const label = config.label;
  $('#tokens-shared-meta').textContent = `${label} · stacked area by category · bucket ${formatBucket(config.bucketMs)}`;
  $('#tokens-models-meta').textContent = `${label} · ${byModel.size} model${byModel.size === 1 ? '' : 's'}`;
  $('#tokens-model-series-meta').textContent = `${label} · one chart per model · stacked by category`;
  $('#tokens-data-note').textContent = `Showing ${fmtNumber(entries.length)} log entr${entries.length === 1 ? 'y' : 'ies'} from the live buffer (500 recent + 10,000 archived). Anything older than the buffer is not shown.`;

  renderTokensKpis(totals);
  renderTokensSharedChart(buckets, config);
  renderTokensModelsTable(byModel);
  renderTokensModelSeries(buckets);
  renderTokensKeySeries(buckets);
}

function formatBucket(ms) {
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3600_000) return `${ms / 60_000}m`;
  return `${ms / 3600_000}h`;
}

const scheduleTokensRender = rAFThrottle(() => {
  if (state.currentPage === 'tokens') renderTokens();
});

function initTokensPage() {
  $$('#tokens-windows .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#tokens-windows .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const w = Number(chip.dataset.window);
      if (Number.isFinite(w) && TOKENS_WINDOWS[w]) {
        tokensState.windowMs = w;
        renderTokens();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Page: Models
// ---------------------------------------------------------------------------

async function renderModels() {
  const host = $('#models-list');
  if (!host) return;

  // Read the provider name from the input (or fall back to the default).
  const providerInput = $('#zen-provider-name');
  if (providerInput && providerInput.value.trim()) {
    state.zenProviderName = providerInput.value.trim();
  }
  const providerName = state.zenProviderName || 'multi-auth-zen';

  const [modelsData, vm, drift] = await Promise.all([
    api.models(),
    api.visibleModels(),
    api.zenProviderModels(providerName).catch((err) => ({
      provider: providerName,
      configured: [],
      live: [],
      missing: [],
      stale: [],
      providerMissing: false,
      liveError: err instanceof Error ? err.message : String(err),
      lastCheckAt: Date.now(),
    })),
  ]);
  const selected = new Set(vm.models || []);
  state.visibleModels = vm.models || null;

  const renderGroup = (title, models) => models.length ? `
    <div class="model-group">
      <div class="model-group-title">${escapeHtml(title)}</div>
      ${models.map((m) => {
        const id = m.id || m;
        const checked = selected.has(id) || selected.size === 0;
        return `
          <label class="model-check-row">
            <input type="checkbox" class="model-check" value="${escapeHtml(id)}" ${checked ? 'checked' : ''}>
            <span class="model-check-id">${escapeHtml(id)}</span>
          </label>
        `;
      }).join('')}
    </div>` : '';

  const goSection = renderGroup('OpenCode Go', modelsData.go || []);
  const zenSection = renderGroup('OpenCode Zen', modelsData.zen || []);
  host.innerHTML = goSection + zenSection;
  if (!goSection && !zenSection) host.innerHTML = '<div class="empty-state">Could not fetch model list from the proxy.</div>';

  // Render the drift card and fire a one-shot toast.
  renderZenDrift(drift);

  // Persist the provider name for the next visit.
  if (providerInput) providerInput.value = state.zenProviderName;

  $('#models-select-all').onclick = () => { $$('.model-check', host).forEach((cb) => cb.checked = true); };
  $('#models-deselect-all').onclick = () => { $$('.model-check', host).forEach((cb) => cb.checked = false); };
  $('#models-save').onclick = async () => {
    const checked = [...$$('.model-check:checked', host)].map((cb) => cb.value);
    try {
      await api.setVisibleModels({ models: checked });
      state.visibleModels = checked.length ? checked : null;
      toast('Visible models saved', 'success');
    } catch (err) {
      toast('Failed to save: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };
}

function renderZenDrift(drift) {
  const card = $('#zen-drift-card');
  const banner = $('#zen-drift-banner');
  const meta = $('#zen-drift-meta');
  if (!card || !banner || !meta) return;

  // Schedule the next 12-hour check.
  if (state.zenDriftTimer) clearTimeout(state.zenDriftTimer);
  state.zenDriftTimer = setTimeout(() => {
    if (state.currentPage === 'models') {
      api.zenProviderModels(state.zenProviderName).then(renderZenDrift).catch(() => {});
    }
  }, 12 * 60 * 60 * 1000);

  const ts = drift.lastCheckAt ? new Date(drift.lastCheckAt).toLocaleString() : '—';
  const providerMissing = drift.providerMissing;
  const missing = drift.missing || [];
  const stale = drift.stale || [];
  const liveError = drift.liveError;

  if (providerMissing) {
    card.style.display = '';
    meta.textContent = `Provider "${drift.provider}" not found in opencode.json · last check ${ts}`;
    banner.innerHTML = `
      <div class="zen-drift-banner is-error">
        <strong>Provider not found.</strong>
        Add a <code>${escapeHtml(drift.provider)}</code> block to your <code>~/.config/opencode/opencode.json</code>
        under <code>provider</code>. Until then, this page can't tell which models your proxy serves.
      </div>
    `;
    announceDriftToast(drift, 'Provider not found', 'error');
    return;
  }

  if (liveError && (!drift.live || drift.live.length === 0)) {
    card.style.display = '';
    meta.textContent = `Could not reach upstream · last check ${ts}`;
    banner.innerHTML = `
      <div class="zen-drift-banner is-error">
        <strong>Upstream unreachable.</strong>
        ${escapeHtml(liveError)} — last check ${ts}. Try again later.
      </div>
    `;
    return;
  }

  if (missing.length === 0 && stale.length === 0) {
    card.style.display = 'none';
    banner.innerHTML = '';
    meta.textContent = '';
    // First-time only, when no drift: a positive "all in sync" toast.
    announceDriftToast(drift, 'Zen catalog in sync', 'success');
    return;
  }

  card.style.display = '';
  meta.textContent = `Last check ${ts}`;

  const missingBlock = missing.length ? `
    <div class="zen-drift-banner is-warning">
      <div class="zen-drift-headline">
        <strong>${missing.length} new model${missing.length === 1 ? '' : 's'} available</strong> from the OpenCode Zen upstream.
      </div>
      <div class="zen-drift-list">
        ${missing.map(m => `<code class="zen-drift-chip">${escapeHtml(m)}</code>`).join('')}
      </div>
      <div class="zen-drift-actions">
        <button class="btn btn-sm btn-primary zen-drift-copy">Copy snippet to paste in opencode.json</button>
        <span class="zen-drift-hint">Paste this into the <code>"models"</code> map of the <code>${escapeHtml(drift.provider)}</code> provider.</span>
      </div>
    </div>
  ` : '';

  const staleBlock = stale.length ? `
    <div class="zen-drift-banner is-muted">
      <div class="zen-drift-headline">
        <strong>${stale.length} configured model${stale.length === 1 ? '' : 's'}</strong> no longer in the upstream catalog:
        ${stale.map(m => `<code class="zen-drift-chip">${escapeHtml(m)}</code>`).join(' ')}
      </div>
    </div>
  ` : '';

  banner.innerHTML = missingBlock + staleBlock;

  const copyBtn = banner.querySelector('.zen-drift-copy');
  if (copyBtn && missing.length) {
    copyBtn.onclick = () => {
      const snippet = JSON.stringify({
        provider: {
          [drift.provider]: {
            models: Object.fromEntries(missing.map(m => [m, {}])),
          },
        },
      }, null, 2);
      navigator.clipboard.writeText(snippet).then(() => {
        toast(`Copied ${missing.length} model${missing.length === 1 ? '' : 's'} to paste into opencode.json`, 'success');
      }).catch(() => {
        toast('Could not copy to clipboard', 'error');
      });
    };
  }

  // Announce (one-shot per signature).
  if (missing.length > 0) {
    announceDriftToast(drift, `${missing.length} new Zen model${missing.length === 1 ? '' : 's'} available`, 'info');
  } else if (stale.length > 0) {
    announceDriftToast(drift, `${stale.length} Zen model${stale.length === 1 ? '' : 's'} no longer available`, 'warn');
  }
}

function announceDriftToast(drift, message, kind) {
  // Build a stable signature: provider + sorted missing + sorted stale.
  const sig = [
    drift.provider,
    (drift.missing || []).slice().sort().join(','),
    (drift.stale || []).slice().sort().join(','),
  ].join('|');
  if (state.zenDriftAnnounced === sig) return;
  state.zenDriftAnnounced = sig;
  toast(message, kind);
}

async function renderSettings() {
  const table = $('#config-table');
  if (!table) return;
  const [status, current, cfg] = await Promise.all([api.status(), api.currentStrategy(), api.config()]);
  const ports = window.location.port ? `:${window.location.port}` : '';
  const baseUrl = `${location.protocol}//${location.hostname}${ports === ':18904' ? ':18905' : ports}`;
  const proxyHost = `${location.protocol}//${location.hostname}:18905`;

  const rows = [
    ['Proxy URL', proxyHost],
    ['Dashboard URL', `${location.protocol}//${location.host}${location.port ? ':' + location.port : ''}`],
    ['Active strategy', current.strategy],
    ['Enabled keys', String(status.summary.enabledKeys)],
    ['Total requests (session)', fmtNumber(status.summary.totalRequests)],
    ['Total tokens observed (session)', fmtTokens(status.summary.totalTokens ?? 0)],
    ['Total cost observed (session)', fmtCurrency(status.summary.observedCost ?? 0)],
    ['Quota errors caught (session)', fmtNumber(status.summary.quotaErrorCount ?? 0)],
  ];
  table.innerHTML = rows.map(([k, v]) => `
    <div class="config-key">${escapeHtml(k)}</div>
    <div class="config-val">${escapeHtml(v)}</div>
  `).join('');

  const ntfyRow = document.getElementById('settings-ntfy');
  if (ntfyRow) {
    const input = ntfyRow.querySelector('.ntfy-input');
    const statusEl = ntfyRow.querySelector('.ntfy-status');
    const saveBtn = ntfyRow.querySelector('.ntfy-save');
    if (input) input.value = cfg.ntfyUrl || '';
    if (statusEl) {
      statusEl.textContent = cfg.ntfyUrl ? 'Notifications enabled' : 'Notifications disabled';
      statusEl.style.color = cfg.ntfyUrl ? 'var(--green)' : 'var(--text-muted)';
    }
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const url = input ? input.value.trim() : '';
        try {
          await api.setConfig({ ntfyUrl: url });
          if (statusEl) {
            statusEl.textContent = url ? 'Notifications enabled' : 'Notifications disabled';
            statusEl.style.color = url ? 'var(--green)' : 'var(--text-muted)';
          }
          toast('Notification URL updated', 'success');
        } catch (err) {
          toast('Failed to save: ' + (err instanceof Error ? err.message : String(err)), 'error');
        }
      };
    }
  }

  $('#provider-config').value = JSON.stringify({
    provider: {
      'opencode-go': { options: { baseURL: proxyHost } },
      'opencode-zen': { api: 'opencode-go', options: { baseURL: `${proxyHost}/zen` } },
    },
  }, null, 2);

  $('#copy-provider-config').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#provider-config').value);
      toast('Copied', 'success');
    } catch {
      $('#provider-config').select();
      document.execCommand('copy');
      toast('Copied', 'success');
    }
  };

  $('#settings-meta').textContent = `Snapshot at ${fmtDateTime(new Date().toISOString())}`;
  $('#footer-dashboard').textContent = `:${location.port || 18904}`;
  $('#footer-proxy').textContent = ':18905';

  // Notification log
  const notifBody = $('#notif-log-body');
  const notifCount = $('#notif-log-count');
  if (notifBody && notifCount) {
    try {
      const history = await api.notifications();
      notifCount.textContent = `${history.length} sent this session`;
      if (!history.length) {
        notifBody.innerHTML = '<div class="empty-state">No notifications sent yet.</div>';
      } else {
        notifBody.innerHTML = history.slice().reverse().slice(0, 20).map((n) => `
          <div class="notif-entry">
            <span class="notif-time">${escapeHtml(fmtDateTime(new Date(n.timestamp).toISOString()))}</span>
            <span class="notif-title">${escapeHtml(n.title)}</span>
            <span class="notif-msg">${escapeHtml(n.message.length > 80 ? n.message.slice(0, 80) + '…' : n.message)}</span>
          </div>
        `).join('');
      }
    } catch {
      notifBody.innerHTML = '<div class="empty-state">Could not load notification log.</div>';
    }
  }
}

// Render settings on first visit
on('settings:first-visit', renderSettings);
