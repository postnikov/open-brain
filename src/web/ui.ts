export const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Brain</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 800px; margin: 0 auto; padding: 20px; padding-bottom: 80px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  h1 { font-size: 24px; color: #fff; }
  h1 span { color: #666; font-weight: 400; font-size: 14px; margin-left: 8px; }
  .header-actions button { background: #1a1a1a; border: 1px solid #333; color: #999; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .header-actions button:hover { color: #fff; border-color: #555; }
  .header-actions button.active { background: #2a2a2a; color: #fff; border-color: #555; }

  .tabs { display: flex; gap: 4px; margin-bottom: 20px; flex-wrap: wrap; }
  .tab { padding: 8px 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; cursor: pointer; color: #999; font-size: 14px; }
  .tab.active { background: #2a2a2a; color: #fff; border-color: #555; }

  .search-box { position: relative; margin-bottom: 20px; }
  .search-box input { width: 100%; padding: 12px 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px; outline: none; }
  .search-box input:focus { border-color: #666; }
  .search-box input::placeholder { color: #555; }

  .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-chip { padding: 4px 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 12px; font-size: 12px; color: #999; cursor: pointer; user-select: none; }
  .filter-chip.active { background: #333; color: #fff; border-color: #555; }

  .thought { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 12px; cursor: pointer; transition: opacity 0.3s, transform 0.3s, max-height 0.5s, margin-bottom 0.3s, padding 0.3s; position: relative; }
  .thought:hover { border-color: #444; }
  .thought.selected { border-color: #4a9; background: #0d1a0d; }
  .thought-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 8px; }
  .thought-title { font-weight: 600; color: #fff; font-size: 15px; }
  .thought-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
  .thought-similarity { color: #4a9; font-size: 13px; font-weight: 500; }
  .weight-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #1a1a2a; color: #88a; }
  .epistemic-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; cursor: pointer; position: relative; }
  .epistemic-badge[data-status="hypothesis"] { background: #2a2a1a; color: #aa8; }
  .epistemic-badge[data-status="conviction"] { background: #1a1a2a; color: #88a; }
  .epistemic-badge[data-status="fact"] { background: #1a2a1a; color: #6a6; }
  .epistemic-badge[data-status="outdated"] { background: #2a1a1a; color: #666; text-decoration: line-through; }
  .epistemic-badge[data-status="question"] { background: #2a1a1a; color: #a66; }
  .epistemic-badge:not([data-status]) { background: #1a1a1a; color: #555; }
  .thought-content { color: #aaa; font-size: 14px; line-height: 1.5; margin-bottom: 10px; white-space: pre-wrap; word-break: break-word; }
  .thought-content.collapsed { max-height: 80px; overflow: hidden; position: relative; }
  .thought-content.collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 30px; background: linear-gradient(transparent, #111); }
  .thought-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .thought-tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { padding: 2px 8px; background: #1a2a1a; border-radius: 4px; font-size: 11px; color: #6a6; }
  .thought-source { font-size: 12px; color: #666; }
  .thought-date { font-size: 12px; color: #666; }
  .thought-actions { margin-left: auto; display: flex; gap: 2px; }
  .thought-actions button { background: none; border: none; color: #555; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; }
  .thought-actions button:hover { color: #fff; background: #333; }
  .thought-actions button[data-action="delete"]:hover, .thought-actions button[data-action="compost"]:hover { color: #c44; background: #2a1a1a; }

  .days-badge { font-size: 11px; padding: 2px 8px; border-radius: 3px; background: #2a1a1a; color: #a66; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
  .stat-label { font-size: 12px; color: #666; margin-top: 4px; }

  .loading { text-align: center; padding: 40px; color: #555; }
  .empty { text-align: center; padding: 40px; color: #555; }
  #status { font-size: 12px; color: #444; text-align: center; margin-top: 20px; }

  .thought.editing { border-color: #555; cursor: default; }
  .thought.editing .thought-content { max-height: none; }
  .thought.editing .thought-content::after { display: none; }
  .edit-title { width: 100%; padding: 4px 8px; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; color: #fff; font-size: 15px; font-weight: 600; font-family: inherit; }
  .edit-content { width: 100%; min-height: 80px; padding: 8px; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; color: #aaa; font-size: 14px; line-height: 1.5; font-family: inherit; resize: vertical; }
  .edit-tags { width: 100%; padding: 4px 8px; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; color: #6a6; font-size: 12px; font-family: inherit; }
  .edit-actions { display: flex; gap: 8px; margin-top: 10px; }
  .edit-actions button { padding: 5px 14px; border-radius: 4px; border: 1px solid #444; cursor: pointer; font-size: 13px; }
  .btn-save { background: #1a3a1a; color: #6a6; border-color: #2a4a2a; }
  .btn-save:hover { background: #2a4a2a; }
  .btn-save:disabled { opacity: 0.5; cursor: wait; }
  .btn-cancel { background: #1a1a1a; color: #999; }
  .btn-cancel:hover { background: #2a2a2a; }
  .edit-status { font-size: 12px; color: #4a9; margin-left: auto; line-height: 28px; }

  .orphan-section h3 { margin: 24px 0 12px; color: #999; font-size: 14px; }
  .orphan-item { display: flex; justify-content: space-between; align-items: center; background: #111; border: 1px solid #222; border-radius: 8px; padding: 10px 16px; margin-bottom: 8px; }
  .orphan-item:hover { border-color: #444; }
  .orphan-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .orphan-thought { color: #666; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .status-menu { position: absolute; top: 100%; right: 0; background: #1a1a1a; border: 1px solid #444; border-radius: 6px; padding: 4px 0; z-index: 10; min-width: 140px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .status-menu-item { padding: 6px 12px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .status-menu-item:hover { background: #333; }

  .dup-pair { background: #111; border: 1px solid #222; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .dup-pair:hover { border-color: #444; }
  .dup-header { padding: 10px 16px; border-bottom: 1px solid #222; display: flex; justify-content: space-between; align-items: center; }
  .dup-sim { color: #4a9; font-weight: 600; font-size: 14px; }
  .dup-body { display: flex; gap: 0; }
  .dup-side { flex: 1; padding: 12px 16px; min-width: 0; }
  .dup-side + .dup-side { border-left: 1px solid #222; }
  .dup-side-title { font-weight: 600; color: #fff; font-size: 14px; margin-bottom: 6px; }
  .dup-side-content { color: #aaa; font-size: 13px; line-height: 1.4; max-height: 120px; overflow: hidden; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
  .dup-side-meta { font-size: 11px; color: #666; }
  .dup-side-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .dup-actions { padding: 10px 16px; border-top: 1px solid #222; display: flex; gap: 8px; }
  .dup-actions button { padding: 5px 12px; border-radius: 4px; border: 1px solid #333; background: #1a1a1a; color: #999; cursor: pointer; font-size: 12px; }
  .dup-actions button:hover { color: #fff; border-color: #555; }
  .dup-actions button.dup-keep { border-color: #1a3a1a; color: #6a6; }
  .dup-actions button.dup-keep:hover { background: #1a3a1a; }
  .dup-actions button.dup-danger { border-color: #2a1a1a; color: #a66; }
  .dup-actions button.dup-danger:hover { background: #2a1a1a; color: #c44; }
  @media (max-width: 600px) { .dup-body { flex-direction: column; } .dup-side + .dup-side { border-left: none; border-top: 1px solid #222; } }

  .review-nav { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
  .review-nav button { background: #1a1a1a; border: 1px solid #333; color: #999; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .review-nav button:hover { color: #fff; border-color: #555; }
  .review-nav .review-label { color: #999; font-size: 14px; }
  .review-actions { display: flex; gap: 4px; margin-top: 8px; }
  .review-actions button { padding: 4px 10px; border-radius: 4px; border: 1px solid #333; background: #1a1a1a; color: #999; cursor: pointer; font-size: 12px; }
  .review-actions button:hover { color: #fff; border-color: #555; }
  .review-actions button.review-true { border-color: #1a3a1a; color: #6a6; }
  .review-actions button.review-true:hover { background: #1a3a1a; }
  .review-actions button.review-letgo { border-color: #2a1a1a; color: #a66; }
  .review-actions button.review-letgo:hover { background: #2a1a1a; }

  .timeline-item { display: flex; gap: 16px; margin-bottom: 0; }
  .timeline-line { width: 40px; display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .timeline-dot { width: 10px; height: 10px; border-radius: 50%; background: #4a9; margin-top: 20px; }
  .timeline-stem { flex: 1; width: 2px; background: #333; }
  .timeline-card { flex: 1; padding-bottom: 12px; }
  .timeline-date-header { color: #666; font-size: 13px; font-weight: 600; padding: 16px 0 8px 56px; border-top: 1px solid #222; margin-top: 8px; }
  .timeline-date-header:first-child { border-top: none; margin-top: 0; }

  .batch-toolbar { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1a1a; border-top: 1px solid #444; padding: 12px 20px; display: flex; align-items: center; gap: 12px; z-index: 20; transform: translateY(100%); transition: transform 0.2s; }
  .batch-toolbar.visible { transform: translateY(0); }
  .batch-toolbar .batch-count { color: #4a9; font-size: 14px; font-weight: 600; min-width: 100px; }
  .batch-toolbar button { padding: 6px 14px; border-radius: 4px; border: 1px solid #444; cursor: pointer; font-size: 13px; background: #1a1a1a; color: #999; }
  .batch-toolbar button:hover { color: #fff; border-color: #555; }
  .batch-toolbar button.batch-danger { border-color: #2a1a1a; color: #a66; }
  .batch-toolbar button.batch-danger:hover { background: #2a1a1a; color: #c44; }
  .batch-toolbar .batch-spacer { flex: 1; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; display: flex; align-items: center; justify-content: center; animation: modalFadeIn 0.15s; }
  @keyframes modalFadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal { background: #1a1a1a; border: 1px solid #444; border-radius: 10px; padding: 24px; max-width: 420px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
  .modal-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 12px; }
  .modal-body { font-size: 14px; color: #aaa; line-height: 1.5; margin-bottom: 20px; }
  .modal-input { width: 100%; padding: 8px 12px; background: #111; border: 1px solid #444; border-radius: 6px; color: #fff; font-size: 14px; font-family: inherit; outline: none; margin-top: 8px; }
  .modal-input:focus { border-color: #666; }
  .modal-buttons { display: flex; gap: 8px; justify-content: flex-end; }
  .modal-btn { padding: 8px 18px; border-radius: 6px; border: 1px solid #444; cursor: pointer; font-size: 13px; font-family: inherit; }
  .modal-btn-cancel { background: #1a1a1a; color: #999; }
  .modal-btn-cancel:hover { background: #2a2a2a; color: #fff; }
  .modal-btn-confirm { background: #1a3a1a; color: #6a6; border-color: #2a4a2a; }
  .modal-btn-confirm:hover { background: #2a4a2a; }
  .modal-btn-danger { background: #2a1a1a; color: #a66; border-color: #3a1a1a; }
  .modal-btn-danger:hover { background: #3a1a1a; color: #c44; }
  .modal-btn-ok { background: #1a1a2a; color: #88a; border-color: #2a2a3a; }
  .modal-btn-ok:hover { background: #2a2a3a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Open Brain <span id="totalCount"></span></h1>
    <div class="header-actions"><button id="batchToggle" data-action="toggle-batch">Select</button></div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="search" onclick="switchTab('search')">Search</div>
    <div class="tab" data-tab="timeline" onclick="switchTab('timeline')">Timeline</div>
    <div class="tab" data-tab="recent" onclick="switchTab('recent')">Recent</div>
    <div class="tab" data-tab="review" onclick="switchTab('review')">Review</div>
    <div class="tab" data-tab="compost" onclick="switchTab('compost')">Compost</div>
    <div class="tab" data-tab="duplicates" onclick="switchTab('duplicates')">Duplicates</div>
    <div class="tab" data-tab="stats" onclick="switchTab('stats')">Stats</div>
  </div>

  <div id="search-view"><div class="search-box"><input type="text" id="searchInput" placeholder="Semantic search..." autofocus></div><div id="searchResults"></div></div>
  <div id="timeline-view" style="display:none"><div class="search-box"><input type="text" id="timelineInput" placeholder="Search topic to see evolution over time..."></div><div id="timelineResults"></div></div>
  <div id="recent-view" style="display:none"><div class="filters" id="sourceFilters"></div><div id="recentResults"></div></div>
  <div id="review-view" style="display:none"><div class="review-nav"><button data-action="review-earlier">\\u2190 Earlier</button><span class="review-label" id="reviewLabel">7 days ago</span><button data-action="review-later">Later \\u2192</button></div><div id="reviewResults"></div></div>
  <div id="compost-view" style="display:none"><div id="compostResults"></div></div>
  <div id="duplicates-view" style="display:none"><div id="duplicatesResults"></div></div>
  <div id="stats-view" style="display:none"><div id="statsContent"></div></div>

  <div id="status"></div>
</div>

<div id="modalRoot"></div>

<div class="batch-toolbar" id="batchToolbar">
  <span class="batch-count" id="batchCount">0 selected</span>
  <button data-action="batch-select-all">All</button>
  <button data-action="batch-clear">Clear</button>
  <span class="batch-spacer"></span>
  <button data-action="batch-tag">+ Tag</button>
  <button data-action="batch-status">Status</button>
  <button class="batch-danger" data-action="batch-compost">Compost</button>
  <button class="batch-danger" data-action="batch-delete">Delete</button>
</div>

<script>
var API = '/api';
var debounceTimer, timelineTimer;
var batchMode = false;
var selectedIds = new Set();
var reviewDaysAgo = 7;
var STATUSES = {hypothesis:'? Hypothesis',conviction:'! Conviction',fact:'\\u2713 Fact',outdated:'\\u2717 Outdated',question:'? Question'};
var TABS = ['search','timeline','recent','review','compost','duplicates','stats'];

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

// --- Modal system (replaces confirm/alert/prompt) ---
function showModal(opts) {
  return new Promise(function(resolve) {
    var root = document.getElementById('modalRoot');
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal';
    var html = '';
    if (opts.title) html += '<div class="modal-title">' + esc(opts.title) + '</div>';
    if (opts.message) html += '<div class="modal-body">' + esc(opts.message) + '</div>';
    if (opts.input !== undefined) {
      html += '<input class="modal-input" id="modalInput" value="' + escAttr(opts.input) + '" placeholder="' + escAttr(opts.placeholder || '') + '" />';
    }
    html += '<div class="modal-buttons">';
    if (opts.type !== 'alert') {
      html += '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>';
    }
    var btnClass = opts.danger ? 'modal-btn-danger' : (opts.type === 'alert' ? 'modal-btn-ok' : 'modal-btn-confirm');
    html += '<button class="modal-btn ' + btnClass + '" id="modalOk">' + esc(opts.okLabel || 'OK') + '</button>';
    html += '</div>';
    modal.innerHTML = html;
    overlay.appendChild(modal);
    root.appendChild(overlay);

    var inp = modal.querySelector('#modalInput');
    if (inp) { inp.focus(); inp.select(); } else { modal.querySelector('#modalOk').focus(); }

    function close(val) { overlay.remove(); resolve(val); }

    modal.querySelector('#modalOk').onclick = function() {
      if (opts.input !== undefined) close(inp.value);
      else close(true);
    };
    var cancelBtn = modal.querySelector('#modalCancel');
    if (cancelBtn) cancelBtn.onclick = function() { close(opts.input !== undefined ? null : false); };
    overlay.onclick = function(e) { if (e.target === overlay) close(opts.input !== undefined ? null : false); };
    if (inp) inp.onkeydown = function(e) { if (e.key === 'Enter') modal.querySelector('#modalOk').click(); if (e.key === 'Escape') close(null); };
    modal.onkeydown = function(e) { if (e.key === 'Escape') close(opts.input !== undefined ? null : false); };
  });
}

function modalConfirm(message, opts) {
  return showModal(Object.assign({ type: 'confirm', title: (opts && opts.title) || 'Confirm', message: message, danger: true, okLabel: (opts && opts.okLabel) || 'Confirm' }, opts || {}));
}

function modalAlert(message, title) {
  return showModal({ type: 'alert', title: title || 'Notice', message: message, okLabel: 'OK' });
}

function modalPrompt(message, defaultVal, opts) {
  return showModal(Object.assign({ type: 'prompt', title: (opts && opts.title) || 'Input', message: message, input: defaultVal || '', okLabel: (opts && opts.okLabel) || 'OK' }, opts || {}));
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
  TABS.forEach(function(v) { document.getElementById(v + '-view').style.display = v === tab ? '' : 'none'; });
  if (tab === 'recent') loadRecent();
  if (tab === 'compost') loadCompost();
  if (tab === 'duplicates') loadDuplicates();
  if (tab === 'stats') loadStats();
  if (tab === 'review') loadReview();
}

function renderThought(t, opts) {
  opts = opts || {};
  var tags = (t.tags || []).map(function(tag) { return '<span class="tag">' + esc(tag) + '</span>'; }).join('');
  var date = t.created_at ? new Date(t.created_at).toLocaleDateString() : '';
  var content = esc(t.content);
  var collapsed = content.length > 200 ? 'collapsed' : '';
  var safeId = escAttr(t.id);
  var weightStyle = t.weight && t.weight !== 1 ? ' style="opacity:' + Math.min(Math.max(0.4 + t.weight * 0.06, 0.5), 1.0) + '"' : '';
  var selClass = selectedIds.has(t.id) ? ' selected' : '';

  var badges = '';
  if (opts.similarity) badges += '<span class="thought-similarity">' + (opts.similarity * 100).toFixed(1) + '%</span>';
  if (t.weight && t.weight !== 1) badges += '<span class="weight-badge">\\u00d7' + t.weight + '</span>';
  if (t.epistemic_status) badges += '<span class="epistemic-badge" data-action="toggle-status" data-status="' + escAttr(t.epistemic_status) + '">' + esc(STATUSES[t.epistemic_status] || t.epistemic_status) + '</span>';
  else badges += '<span class="epistemic-badge" data-action="toggle-status" title="Set status">\\u00b7</span>';
  if (opts.days_remaining !== undefined) badges += '<span class="days-badge">' + opts.days_remaining + 'd left</span>';

  var actions = '';
  if (opts.composted) {
    actions = '<button data-action="restore" title="Restore">\\u21a9</button><button data-action="delete" title="Delete permanently">\\ud83d\\uddd1</button>';
  } else if (opts.review) {
    actions = '<button class="review-true" data-action="amplify" title="Still true">\\u2713 True</button>' +
      '<button data-action="edit" title="Evolved">\\u270e Evolved</button>' +
      '<button class="review-letgo" data-action="compost" title="Let go">\\ud83c\\udf31 Let go</button>';
  } else {
    actions = '<button data-action="fade" title="Fade">\\u25bc</button><button data-action="amplify" title="Amplify">\\u25b2</button>' +
      '<button data-action="edit" title="Edit">\\u270e</button><button data-action="compost" title="Compost">\\ud83c\\udf31</button>' +
      '<button data-action="delete" title="Delete">\\ud83d\\uddd1</button>';
  }

  return '<div class="thought' + selClass + '" data-id="' + safeId + '"' + weightStyle + '>' +
    '<div class="thought-header"><span class="thought-title">' + esc(t.title || 'Untitled') + '</span><div class="thought-badges">' + badges + '</div></div>' +
    '<div class="thought-content ' + collapsed + '">' + content + '</div>' +
    '<div class="thought-meta"><div class="thought-tags">' + tags + '</div>' +
    '<span class="thought-source">' + esc(t.source) + '</span><span class="thought-date">' + date + '</span>' +
    '<div class="thought-actions">' + actions + '</div></div></div>';
}

// --- Event delegation ---
document.addEventListener('click', function(e) {
  var existingMenu = document.querySelector('.status-menu');
  if (existingMenu && !existingMenu.contains(e.target)) existingMenu.remove();

  var btn = e.target.closest('[data-action]');
  if (btn) {
    e.stopPropagation();
    var card = btn.closest('.thought') || btn.closest('.orphan-item');
    var id = card ? card.dataset.id : null;
    var action = btn.dataset.action;

    if (action === 'edit' && id) startEdit(id);
    if (action === 'delete' && id) deleteThought(id);
    if (action === 'save-edit' && id) saveEdit(id);
    if (action === 'cancel-edit') cancelEdit(btn);
    if (action === 'fade' && id) adjustWeight(id, 'fade');
    if (action === 'amplify' && id) adjustWeight(id, 'amplify');
    if (action === 'compost' && id) compostThought(id);
    if (action === 'restore' && id) restoreThought(id);
    if (action === 'toggle-status' && id) showStatusMenu(btn, id);
    if (action === 'set-status' && id) setStatus(id, btn.dataset.status || null);
    if (action === 'remove-orphan') removeOrphanTag(btn.dataset.tag, btn.dataset.thoughtId);
    if (action === 'rename-orphan') renameOrphanTag(btn.dataset.tag);
    if (action === 'toggle-batch') toggleBatchMode();
    if (action === 'review-earlier') { reviewDaysAgo += 7; loadReview(); }
    if (action === 'review-later') { reviewDaysAgo = Math.max(1, reviewDaysAgo - 7); loadReview(); }
    if (action === 'batch-select-all') batchSelectAll();
    if (action === 'batch-clear') batchClear();
    if (action === 'batch-delete') batchAction('delete');
    if (action === 'batch-compost') batchAction('compost');
    if (action === 'batch-tag') batchAddTag();
    if (action === 'batch-status') batchSetStatus();
    if (action === 'dup-keep-a') dupKeep(btn.dataset.keepId, btn.dataset.removeId);
    if (action === 'dup-keep-b') dupKeep(btn.dataset.keepId, btn.dataset.removeId);
    if (action === 'dup-keep-both') dupDismiss(btn.dataset.idA, btn.dataset.idB, btn);
    if (action === 'dup-merge') dupMerge(btn.dataset.keepId, btn.dataset.removeId);
    return;
  }

  var thought = e.target.closest('.thought');
  if (thought && !thought.classList.contains('editing')) {
    if (batchMode) {
      var tid = thought.dataset.id;
      if (selectedIds.has(tid)) { selectedIds.delete(tid); thought.classList.remove('selected'); }
      else { selectedIds.add(tid); thought.classList.add('selected'); }
      updateBatchCount();
    } else {
      var c = thought.querySelector('.thought-content');
      if (c) c.classList.toggle('collapsed');
    }
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && batchMode) toggleBatchMode();
});

// --- Search ---
async function search(query) {
  if (!query.trim()) { document.getElementById('searchResults').innerHTML = ''; return; }
  document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...</div>';
  try {
    var r = await fetch(API + '/search?q=' + encodeURIComponent(query) + '&limit=20');
    var data = await r.json();
    if (!data.results || data.results.length === 0) { document.getElementById('searchResults').innerHTML = '<div class="empty">No results</div>'; return; }
    document.getElementById('searchResults').innerHTML = data.results.map(function(r) { return renderThought(r, {similarity: r.similarity}); }).join('');
  } catch(e) { document.getElementById('searchResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Timeline ---
async function searchTimeline(query) {
  if (!query.trim()) { document.getElementById('timelineResults').innerHTML = ''; return; }
  document.getElementById('timelineResults').innerHTML = '<div class="loading">Building timeline...</div>';
  try {
    var r = await fetch(API + '/timeline?q=' + encodeURIComponent(query) + '&limit=30');
    var data = await r.json();
    if (!data.results || data.results.length === 0) { document.getElementById('timelineResults').innerHTML = '<div class="empty">No results for this topic</div>'; return; }

    var html = '';
    var lastMonth = '';
    data.results.forEach(function(r, i) {
      var d = r.created_at ? new Date(r.created_at) : null;
      var month = d ? d.toLocaleDateString(undefined, {year:'numeric',month:'long'}) : '';
      if (month !== lastMonth) { html += '<div class="timeline-date-header">' + esc(month) + '</div>'; lastMonth = month; }
      var isLast = i === data.results.length - 1;
      html += '<div class="timeline-item"><div class="timeline-line"><div class="timeline-dot"></div>' + (isLast ? '' : '<div class="timeline-stem"></div>') + '</div>';
      html += '<div class="timeline-card">' + renderThought(r, {similarity: r.similarity}) + '</div></div>';
    });
    document.getElementById('timelineResults').innerHTML = html;
  } catch(e) { document.getElementById('timelineResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Recent ---
async function loadRecent(source) {
  document.getElementById('recentResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var url = API + '/recent?limit=50';
    if (source) url += '&source=' + encodeURIComponent(source);
    var r = await fetch(url);
    var data = await r.json();
    document.getElementById('recentResults').innerHTML = data.thoughts.map(function(t) { return renderThought(t); }).join('');
  } catch(e) { document.getElementById('recentResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Review ---
async function loadReview() {
  document.getElementById('reviewLabel').textContent = reviewDaysAgo + ' days ago';
  document.getElementById('reviewResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var r = await fetch(API + '/review?days_ago=' + reviewDaysAgo + '&limit=10');
    var data = await r.json();
    if (!data.thoughts || data.thoughts.length === 0) {
      document.getElementById('reviewResults').innerHTML = '<div class="empty">Nothing from this period. Try a different date.</div>';
      return;
    }
    document.getElementById('reviewResults').innerHTML =
      '<p style="color:#666;font-size:13px;margin-bottom:16px">' + data.period.from + ' \\u2014 ' + data.period.to + ' \\u00b7 ' + data.total + ' thoughts</p>' +
      data.thoughts.map(function(t) { return renderThought(t, {review: true}); }).join('');
  } catch(e) { document.getElementById('reviewResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Compost ---
async function loadCompost() {
  document.getElementById('compostResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var r = await fetch(API + '/compost');
    var data = await r.json();
    if (!data.thoughts || data.thoughts.length === 0) { document.getElementById('compostResults').innerHTML = '<div class="empty">Compost is empty.</div>'; return; }
    document.getElementById('compostResults').innerHTML = data.thoughts.map(function(t) { return renderThought(t, {composted: true, days_remaining: t.days_remaining}); }).join('');
  } catch(e) { document.getElementById('compostResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Duplicates ---
async function loadDuplicates() {
  document.getElementById('duplicatesResults').innerHTML = '<div class="loading">Scanning for duplicates...</div>';
  try {
    var r = await fetch(API + '/duplicates?min_similarity=0.92&limit=20');
    var data = await r.json();
    if (!data.pairs || data.pairs.length === 0) {
      document.getElementById('duplicatesResults').innerHTML = '<div class="empty">No duplicates found. Your brain is clean!</div>';
      return;
    }
    document.getElementById('duplicatesResults').innerHTML = data.pairs.map(function(p) {
      var a = p.thought_a, b = p.thought_b, sim = p.similarity;
      var aTags = (a.tags || []).map(function(t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
      var bTags = (b.tags || []).map(function(t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
      var aDate = a.created_at ? new Date(a.created_at).toLocaleDateString() : '';
      var bDate = b.created_at ? new Date(b.created_at).toLocaleDateString() : '';
      return '<div class="dup-pair">' +
        '<div class="dup-header"><span class="dup-sim">' + (sim * 100).toFixed(1) + '% similar</span></div>' +
        '<div class="dup-body">' +
          '<div class="dup-side"><div class="dup-side-title">' + esc(a.title || 'Untitled') + '</div>' +
            '<div class="dup-side-content">' + esc(a.content) + '</div>' +
            '<div class="dup-side-meta">' + esc(a.source) + ' \\u00b7 ' + aDate + '</div>' +
            '<div class="dup-side-tags">' + aTags + '</div></div>' +
          '<div class="dup-side"><div class="dup-side-title">' + esc(b.title || 'Untitled') + '</div>' +
            '<div class="dup-side-content">' + esc(b.content) + '</div>' +
            '<div class="dup-side-meta">' + esc(b.source) + ' \\u00b7 ' + bDate + '</div>' +
            '<div class="dup-side-tags">' + bTags + '</div></div>' +
        '</div>' +
        '<div class="dup-actions">' +
          '<button class="dup-keep" data-action="dup-keep-a" data-keep-id="' + escAttr(a.id) + '" data-remove-id="' + escAttr(b.id) + '">Keep A</button>' +
          '<button class="dup-keep" data-action="dup-keep-b" data-keep-id="' + escAttr(b.id) + '" data-remove-id="' + escAttr(a.id) + '">Keep B</button>' +
          '<button data-action="dup-keep-both" data-id-a="' + escAttr(a.id) + '" data-id-b="' + escAttr(b.id) + '">Keep Both</button>' +
          '<button class="dup-danger" data-action="dup-merge" data-keep-id="' + escAttr(a.id) + '" data-remove-id="' + escAttr(b.id) + '">Merge (keep A)</button>' +
        '</div></div>';
    }).join('');
  } catch(e) { document.getElementById('duplicatesResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

async function dupKeep(keepId, removeId) {
  if (!await modalConfirm('Delete the other thought permanently?', { title: 'Keep One', okLabel: 'Delete' })) return;
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(removeId), { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadDuplicates();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

async function dupDismiss(idA, idB, btn) {
  try {
    var r = await fetch(API + '/duplicates/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_a: idA, id_b: idB }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    var pair = btn.closest('.dup-pair');
    if (pair) { pair.style.opacity = '0'; pair.style.transition = 'opacity 0.3s'; setTimeout(function() { pair.remove(); }, 300); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

async function dupMerge(keepId, removeId) {
  if (!await modalConfirm('Merge tags/topics into kept thought and delete the other?', { title: 'Merge Thoughts', okLabel: 'Merge' })) return;
  try {
    var r = await fetch(API + '/duplicates/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep_id: keepId, remove_id: removeId }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadDuplicates();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Stats ---
async function loadStats() {
  document.getElementById('statsContent').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var r = await fetch(API + '/stats');
    var s = await r.json();
    var html = '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-value">' + s.total + '</div><div class="stat-label">Total thoughts</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + s.last_7_days + '</div><div class="stat-label">Last 7 days</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + s.last_30_days + '</div><div class="stat-label">Last 30 days</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + Object.keys(s.by_source || {}).length + '</div><div class="stat-label">Sources</div></div></div>';
    if (s.by_source) { html += '<h3 style="margin:16px 0 8px;color:#999;font-size:14px">By Source</h3><div class="stats-grid">'; for (var k in s.by_source) html += '<div class="stat-card"><div class="stat-value">' + s.by_source[k] + '</div><div class="stat-label">' + esc(k) + '</div></div>'; html += '</div>'; }
    if (s.by_type) { html += '<h3 style="margin:16px 0 8px;color:#999;font-size:14px">By Type</h3><div class="stats-grid">'; for (var k2 in s.by_type) html += '<div class="stat-card"><div class="stat-value">' + s.by_type[k2] + '</div><div class="stat-label">' + esc(k2) + '</div></div>'; html += '</div>'; }
    try {
      var ot = await fetch(API + '/tags/orphans'); var orphanData = await ot.json();
      if (orphanData.orphans && orphanData.orphans.length > 0) {
        html += '<div class="orphan-section"><h3>Orphan Tags (' + orphanData.total + ')</h3>';
        orphanData.orphans.forEach(function(o) {
          var st = escAttr(o.tag), si = o.thought ? escAttr(o.thought.id) : '';
          html += '<div class="orphan-item" data-id="' + si + '"><div class="orphan-info"><span class="tag">' + esc(o.tag) + '</span>';
          if (o.thought) html += '<span class="orphan-thought">' + esc(o.thought.title || 'Untitled') + '</span>';
          html += '</div><div class="thought-actions"><button data-action="rename-orphan" data-tag="' + st + '" title="Rename">&#9998;</button>';
          if (o.thought) html += '<button data-action="remove-orphan" data-tag="' + st + '" data-thought-id="' + si + '" title="Remove">&#10005;</button>';
          html += '</div></div>';
        }); html += '</div>';
      }
    } catch(e) {}
    document.getElementById('statsContent').innerHTML = html;
    document.getElementById('totalCount').textContent = s.total + ' thoughts';
  } catch(e) { document.getElementById('statsContent').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Delete ---
async function deleteThought(id) {
  if (!await modalConfirm('Delete this thought permanently?', { title: 'Delete Thought', okLabel: 'Delete' })) return;
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  if (card) card.style.opacity = '0.5';
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(20px)'; card.style.maxHeight = '0'; card.style.overflow = 'hidden'; card.style.marginBottom = '0'; card.style.padding = '0'; setTimeout(function() { card.remove(); }, 350); }
  } catch (err) { if (card) card.style.opacity = '1'; await modalAlert(err.message, 'Error'); }
}

// --- Fade / Amplify ---
async function adjustWeight(id, direction) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/weight', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: direction }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    if (card) {
      var wb = card.querySelector('.weight-badge');
      if (data.weight === 1) { if (wb) wb.remove(); }
      else { if (!wb) { wb = document.createElement('span'); wb.className = 'weight-badge'; card.querySelector('.thought-badges').insertBefore(wb, card.querySelector('.epistemic-badge')); } wb.textContent = '\\u00d7' + data.weight; }
      card.style.opacity = Math.min(Math.max(0.4 + data.weight * 0.06, 0.5), 1.0);
    }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Compost / Restore ---
async function compostThought(id) {
  if (!await modalConfirm('Send this thought to compost? It will dissolve in 30 days.', { title: 'Compost', okLabel: 'Compost' })) return;
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/compost', { method: 'POST' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(-20px)'; card.style.maxHeight = '0'; card.style.overflow = 'hidden'; card.style.marginBottom = '0'; card.style.padding = '0'; setTimeout(function() { card.remove(); }, 350); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

async function restoreThought(id) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(20px)'; setTimeout(function() { card.remove(); }, 350); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Epistemic Status ---
function showStatusMenu(badge, id) {
  var existing = document.querySelector('.status-menu'); if (existing) { existing.remove(); return; }
  var menu = document.createElement('div'); menu.className = 'status-menu';
  [{key:'hypothesis',label:'? Hypothesis'},{key:'conviction',label:'! Conviction'},{key:'fact',label:'\\u2713 Fact'},{key:'outdated',label:'\\u2717 Outdated'},{key:'question',label:'? Question'},{key:'',label:'\\u2014 Clear'}].forEach(function(item) {
    var div = document.createElement('div'); div.className = 'status-menu-item'; div.textContent = item.label; div.dataset.action = 'set-status'; div.dataset.status = item.key; menu.appendChild(div);
  });
  badge.style.position = 'relative'; badge.appendChild(menu);
}

async function setStatus(id, status) {
  var existing = document.querySelector('.status-menu'); if (existing) existing.remove();
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status || null }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
    if (card) { var badge = card.querySelector('.epistemic-badge'); if (badge) { if (data.epistemic_status) { badge.dataset.status = data.epistemic_status; badge.textContent = STATUSES[data.epistemic_status] || data.epistemic_status; } else { delete badge.dataset.status; badge.textContent = '\\u00b7'; } } }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Orphan tags ---
async function removeOrphanTag(tag, thoughtId) {
  if (!await modalConfirm('Remove tag "' + tag + '" from this thought?', { title: 'Remove Tag', okLabel: 'Remove' })) return;
  try { var r = await fetch(API + '/tags/' + encodeURIComponent(tag) + '/from/' + encodeURIComponent(thoughtId), { method: 'DELETE' }); if (!r.ok) throw new Error('Failed'); loadStats(); }
  catch(err) { await modalAlert(err.message, 'Error'); }
}
async function renameOrphanTag(oldTag) {
  var n = await modalPrompt('Enter new name for tag "' + oldTag + '":', oldTag, { title: 'Rename Tag', okLabel: 'Rename' });
  if (!n || n === oldTag) return;
  try { var r = await fetch(API + '/tags/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_tag: oldTag, new_tag: n }) }); if (!r.ok) throw new Error('Failed'); loadStats(); }
  catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Inline Edit ---
function startEdit(id) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]'); if (!card || card.classList.contains('editing')) return;
  var te = card.querySelector('.thought-title'), ce = card.querySelector('.thought-content'), tge = card.querySelector('.thought-tags');
  var ot = te.textContent || '', oc = ce.textContent || '', otg = Array.from(tge.querySelectorAll('.tag')).map(function(t) { return t.textContent; });
  card.dataset.origTitle = ot; card.dataset.origContent = oc; card.dataset.origTags = JSON.stringify(otg); card.classList.add('editing');
  var ti = document.createElement('input'); ti.className = 'edit-title'; ti.value = ot; te.textContent = ''; te.appendChild(ti);
  ce.classList.remove('collapsed'); var ca = document.createElement('textarea'); ca.className = 'edit-content'; ca.value = oc; ce.textContent = ''; ce.appendChild(ca);
  var tgi = document.createElement('input'); tgi.className = 'edit-tags'; tgi.value = otg.join(', '); tgi.placeholder = 'Tags (comma-separated)'; tge.textContent = ''; tge.appendChild(tgi);
  var eb = document.createElement('div'); eb.className = 'edit-actions'; eb.innerHTML = '<button class="btn-save" data-action="save-edit">Save</button><button class="btn-cancel" data-action="cancel-edit">Cancel</button><span class="edit-status"></span>'; card.appendChild(eb);
}
async function saveEdit(id) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]'); if (!card) return;
  var sb = card.querySelector('.btn-save'), se = card.querySelector('.edit-status');
  var nt = card.querySelector('.edit-title').value.trim(), nc = card.querySelector('.edit-content').value.trim();
  var ntg = card.querySelector('.edit-tags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  if (!nc) { modalAlert('Content cannot be empty', 'Validation'); return; }
  sb.disabled = true; se.textContent = 'Saving...';
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: nc, title: nt, tags: ntg }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    if (data.re_embedded) { se.textContent = 'Re-embedded!'; await new Promise(function(resolve) { setTimeout(resolve, 600); }); }
    finishEdit(card, data);
  } catch(err) { sb.disabled = false; se.textContent = 'Error: ' + err.message; }
}
function cancelEdit(btn) { var c = btn.closest('.thought'); if (!c) return; finishEdit(c, { title: c.dataset.origTitle, content: c.dataset.origContent, tags: JSON.parse(c.dataset.origTags || '[]') }); }
function finishEdit(card, data) {
  card.classList.remove('editing'); var eb = card.querySelector('.edit-actions'); if (eb) eb.remove();
  card.querySelector('.thought-title').textContent = data.title || 'Untitled';
  var ce = card.querySelector('.thought-content'); ce.textContent = data.content; if (data.content && data.content.length > 200) ce.classList.add('collapsed');
  card.querySelector('.thought-tags').innerHTML = (data.tags || []).map(function(tag) { return '<span class="tag">' + esc(tag) + '</span>'; }).join('');
  delete card.dataset.origTitle; delete card.dataset.origContent; delete card.dataset.origTags;
}

// --- Batch mode ---
function toggleBatchMode() {
  batchMode = !batchMode;
  document.getElementById('batchToggle').classList.toggle('active', batchMode);
  document.getElementById('batchToggle').textContent = batchMode ? 'Done' : 'Select';
  if (!batchMode) { batchClear(); }
  document.getElementById('batchToolbar').classList.toggle('visible', batchMode);
}
function updateBatchCount() {
  document.getElementById('batchCount').textContent = selectedIds.size + ' selected';
  document.getElementById('batchToolbar').classList.toggle('visible', batchMode && selectedIds.size > 0);
}
function batchSelectAll() {
  document.querySelectorAll('.thought[data-id]').forEach(function(c) { selectedIds.add(c.dataset.id); c.classList.add('selected'); });
  updateBatchCount();
}
function batchClear() {
  selectedIds.clear();
  document.querySelectorAll('.thought.selected').forEach(function(c) { c.classList.remove('selected'); });
  updateBatchCount();
}
async function batchAction(action) {
  if (selectedIds.size === 0) return;
  var label = action === 'delete' ? 'permanently delete' : action;
  if (!await modalConfirm(label.charAt(0).toUpperCase() + label.slice(1) + ' ' + selectedIds.size + ' thoughts?', { title: 'Batch ' + action, okLabel: label.charAt(0).toUpperCase() + label.slice(1) })) return;
  try {
    var r = await fetch(API + '/thoughts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action: action }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    batchClear();
    var activeTab = document.querySelector('.tab.active');
    if (activeTab) switchTab(activeTab.dataset.tab);
  } catch(err) { await modalAlert(err.message, 'Error'); }
}
async function batchAddTag() {
  if (selectedIds.size === 0) return;
  var tag = await modalPrompt('Add tag to ' + selectedIds.size + ' thoughts:', '', { title: 'Add Tag', okLabel: 'Add' });
  if (!tag) return;
  try {
    var r = await fetch(API + '/thoughts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action: 'add_tag', params: { tag: tag } }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    batchClear(); var activeTab = document.querySelector('.tab.active'); if (activeTab) switchTab(activeTab.dataset.tab);
  } catch(err) { await modalAlert(err.message, 'Error'); }
}
async function batchSetStatus() {
  if (selectedIds.size === 0) return;
  var status = await modalPrompt('Set status (hypothesis / conviction / fact / outdated / question):', '', { title: 'Set Status', okLabel: 'Set' });
  if (!status) return;
  try {
    var r = await fetch(API + '/thoughts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action: 'set_status', params: { status: status } }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    batchClear(); var activeTab = document.querySelector('.tab.active'); if (activeTab) switchTab(activeTab.dataset.tab);
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Init ---
document.getElementById('searchInput').addEventListener('input', function(e) { clearTimeout(debounceTimer); debounceTimer = setTimeout(function() { search(e.target.value); }, 400); });
document.getElementById('searchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(debounceTimer); search(e.target.value); } });
document.getElementById('timelineInput').addEventListener('input', function(e) { clearTimeout(timelineTimer); timelineTimer = setTimeout(function() { searchTimeline(e.target.value); }, 600); });
document.getElementById('timelineInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(timelineTimer); searchTimeline(e.target.value); } });
fetch(API + '/stats').then(function(r) { return r.json(); }).then(function(s) { document.getElementById('totalCount').textContent = s.total + ' thoughts'; }).catch(function() {});
</script>
</body>
</html>`
