var API = '/api';
var debounceTimer, timelineTimer;
var batchMode = false;
var selectedIds = new Set();
var reviewDaysAgo = 7;
var STATUSES = {hypothesis:'? Hypothesis',conviction:'! Conviction',fact:'\u2713 Fact',outdated:'\u2717 Outdated',question:'? Question'};
var TABS = ['search','timeline','recent','review','compost','duplicates','stream','import','activity','stats','distill-log'];

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
  if (tab === 'stream') { loadStream(); loadDistillationStatus(); checkExpiringBlocks(); }
  if (tab === 'activity') loadActivity();
  if (tab === 'stats') loadBrainStatus();
  if (tab === 'review') loadReview();
  if (tab === 'distill-log') loadDistillLog();
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
  if (t.weight && t.weight !== 1) badges += '<span class="weight-badge">\u00d7' + t.weight + '</span>';
  if (t.epistemic_status) badges += '<span class="epistemic-badge" data-action="toggle-status" data-status="' + escAttr(t.epistemic_status) + '">' + esc(STATUSES[t.epistemic_status] || t.epistemic_status) + '</span>';
  else badges += '<span class="epistemic-badge" data-action="toggle-status" title="Set status">\u00b7</span>';
  if (opts.days_remaining !== undefined) badges += '<span class="days-badge">' + opts.days_remaining + 'd left</span>';

  var actions = '';
  if (opts.composted) {
    actions = '<button data-action="restore" title="Restore">\u21a9</button><button data-action="delete" title="Delete permanently">\ud83d\uddd1</button>';
  } else if (opts.review) {
    actions = '<button class="review-true" data-action="amplify" title="Still true">\u2713 True</button>' +
      '<button data-action="edit" title="Evolved">\u270e Evolved</button>' +
      '<button class="review-letgo" data-action="compost" title="Let go">\ud83c\udf31 Let go</button>';
  } else {
    actions = '<button data-action="fade" title="Fade">\u25bc</button><button data-action="amplify" title="Amplify">\u25b2</button>' +
      '<button data-action="edit" title="Edit">\u270e</button><button data-action="compost" title="Compost">\ud83c\udf31</button>' +
      '<button data-action="delete" title="Delete">\ud83d\uddd1</button>';
  }

  var sourceBadge = '';
  if (t.source === 'distillation' && t.source_ref) {
    try { var ref = JSON.parse(t.source_ref); if (ref.session_ids && ref.session_ids.length > 0) sourceBadge = '<span class="source-badge" title="From stream sessions: ' + escAttr(ref.session_ids.join(', ').slice(0, 80)) + '">from stream</span>'; } catch(e) {}
  }

  return '<div class="thought' + selClass + '" data-id="' + safeId + '"' + weightStyle + '>' +
    '<div class="thought-header"><span class="thought-title">' + esc(t.title || 'Untitled') + '</span><div class="thought-badges">' + badges + '</div></div>' +
    '<div class="thought-content ' + collapsed + '">' + content + '</div>' +
    '<div class="thought-meta"><div class="thought-tags">' + tags + '</div>' +
    '<span class="thought-source">' + esc(t.source) + sourceBadge + '</span><span class="thought-date">' + date + '</span>' +
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
      '<p style="color:#666;font-size:13px;margin-bottom:16px">' + data.period.from + ' \u2014 ' + data.period.to + ' \u00b7 ' + data.total + ' thoughts</p>' +
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
            '<div class="dup-side-meta">' + esc(a.source) + ' \u00b7 ' + aDate + '</div>' +
            '<div class="dup-side-tags">' + aTags + '</div></div>' +
          '<div class="dup-side"><div class="dup-side-title">' + esc(b.title || 'Untitled') + '</div>' +
            '<div class="dup-side-content">' + esc(b.content) + '</div>' +
            '<div class="dup-side-meta">' + esc(b.source) + ' \u00b7 ' + bDate + '</div>' +
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

// --- Stream ---
var streamSearchTimer = null;

async function loadStream() {
  var sessionFilter = document.getElementById('streamSessionFilter').value;
  var statusFilter = document.getElementById('streamStatusFilter').value;
  var searchVal = document.getElementById('streamSearchInput').value.trim();
  var params = new URLSearchParams({ limit: '100' });
  if (sessionFilter) params.set('session_id', sessionFilter);
  if (statusFilter) params.set('status', statusFilter);
  if (searchVal) params.set('search', searchVal);

  try {
    var [blocksRes, statsRes, sessionsRes] = await Promise.all([
      fetch(API + '/stream?' + params.toString()),
      fetch(API + '/stream/stats'),
      fetch(API + '/stream/sessions?limit=50'),
    ]);
    var blocksData = await blocksRes.json();
    var statsData = await statsRes.json();
    var sessionsData = await sessionsRes.json();

    // Stats bar
    var statsEl = document.getElementById('streamStats');
    statsEl.innerHTML = 'Blocks: <span>' + statsData.total_blocks + '</span> | Sessions: <span>' + statsData.total_sessions + '</span> | Pending: <span>' + statsData.pending_blocks + '</span> | Distilled: <span>' + statsData.distilled_blocks + '</span> | Pinned: <span>' + statsData.pinned_blocks + '</span>';

    // Session filter dropdown
    var sel = document.getElementById('streamSessionFilter');
    var curVal = sel.value;
    var opts = '<option value="">All sessions</option>';
    (sessionsData.sessions || []).forEach(function(s) {
      var label = (s.topic || s.session_id.slice(0, 16)) + ' (' + s.block_count + ')';
      opts += '<option value="' + escAttr(s.session_id) + '"' + (s.session_id === curVal ? ' selected' : '') + '>' + esc(label) + '</option>';
    });
    sel.innerHTML = opts;

    // Blocks
    var container = document.getElementById('streamResults');
    if (!blocksData.blocks || blocksData.blocks.length === 0) {
      container.innerHTML = '<div style="color:#555;text-align:center;padding:40px">No stream blocks yet</div>';
      return;
    }

    container.innerHTML = blocksData.blocks.map(function(b) {
      var cls = 'stream-block';
      if (b.pinned) cls += ' pinned';
      if (b.distilled) cls += ' distilled';
      var date = b.created_at ? new Date(b.created_at).toLocaleString() : '';
      var expires = b.expires_at ? new Date(b.expires_at).toLocaleDateString() : '';
      var participants = (b.participants || []).join(', ');

      return '<div class="' + cls + '">' +
        '<div class="stream-header">' +
          '<div>' +
            '<span class="stream-session-badge">' + esc(b.session_id.slice(0, 16)) + ' #' + b.block_number + '</span>' +
            (b.topic ? ' <span class="stream-topic">' + esc(b.topic) + '</span>' : '') +
          '</div>' +
          '<div class="stream-actions">' +
            '<button onclick="toggleStreamPin(\'' + b.id + '\', ' + !b.pinned + ')">' + (b.pinned ? 'Unpin' : 'Pin') + '</button>' +
            '<button onclick="deleteStreamBlock(\'' + b.id + '\')" style="color:#a66">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="stream-content">' + esc(b.content) + '</div>' +
        '<div class="stream-meta">' +
          '<span>' + esc(date) + '</span>' +
          (b.source_client ? '<span>via ' + esc(b.source_client) + '</span>' : '') +
          (participants ? '<span>Participants: ' + esc(participants) + '</span>' : '') +
          (b.distilled ? '<span style="color:#4a9">distilled</span>' + (b.distillation_run_id ? '<span class="stream-thought-link" onclick="event.stopPropagation();showRunThoughts(\'' + b.distillation_run_id + '\')">→ thoughts</span>' : '') : '') +
          (expires && !b.pinned ? '<span>expires ' + esc(expires) + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch(err) {
    document.getElementById('streamResults').innerHTML = '<div style="color:#a66;text-align:center;padding:20px">Error loading stream: ' + esc(err.message) + '</div>';
  }
}

async function toggleStreamPin(id, pinned) {
  try {
    var r = await fetch(API + '/stream/' + id + '/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: pinned }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadStream();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

async function deleteStreamBlock(id) {
  if (!await modalConfirm('Delete this stream block?', { title: 'Delete Block', okLabel: 'Delete' })) return;
  try {
    var r = await fetch(API + '/stream/' + id, { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadStream();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Import ---
var pendingFiles = [];
var importPollTimer = null;

function setupDropZone() {
  var dz = document.getElementById('dropZone');
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function(e) { e.preventDefault(); dz.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
  document.getElementById('fileInput').addEventListener('change', function(e) { addFiles(e.target.files); e.target.value = ''; });
}

function addFiles(fileList) {
  Array.from(fileList).forEach(function(f) {
    if (!f.name.match(/\.(md|txt)$/i)) return;
    var reader = new FileReader();
    reader.onload = function() {
      pendingFiles.push({ name: f.name, content: reader.result, size: f.size });
      renderPendingFiles();
    };
    reader.readAsText(f);
  });
}

function renderPendingFiles() {
  var el = document.getElementById('uploadFileList');
  if (pendingFiles.length === 0) { el.innerHTML = ''; document.getElementById('uploadControls').style.display = 'none'; return; }
  document.getElementById('uploadControls').style.display = 'flex';
  document.getElementById('uploadBtn').textContent = 'Import ' + pendingFiles.length + ' file' + (pendingFiles.length > 1 ? 's' : '');
  el.innerHTML = pendingFiles.map(function(f, i) {
    return '<div class="file-item"><span class="file-name">' + esc(f.name) + '</span><span class="file-size">' + formatSize(f.size) + '</span><button onclick="removePendingFile(' + i + ')">\u2715</button></div>';
  }).join('');
}

function removePendingFile(i) { pendingFiles.splice(i, 1); renderPendingFiles(); }

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

async function startFileUpload() {
  if (pendingFiles.length === 0) return;
  var source = document.getElementById('uploadSource').value;
  var files = pendingFiles.map(function(f) { return { name: f.name, content: f.content }; });
  try {
    var r = await fetch(API + '/import/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: files, source: source }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    pendingFiles = [];
    renderPendingFiles();
    startProgressPoll();
  } catch(err) { await modalAlert(err.message, 'Import Error'); }
}

async function scanVault() {
  var path = document.getElementById('vaultPath').value.trim();
  if (!path) return;
  document.getElementById('vaultResults').innerHTML = '<div class="loading">Scanning...</div>';
  try {
    var r = await fetch(API + '/import/obsidian/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Scan failed');
    if (data.files.length === 0) { document.getElementById('vaultResults').innerHTML = '<div class="empty">No .md files found in this path</div>'; return; }
    var html = '<div style="display:flex;gap:8px;margin:12px 0"><button onclick="toggleAllVault(true)">Select All</button><button onclick="toggleAllVault(false)">Clear</button><span style="color:#666;font-size:12px;line-height:28px">' + data.total + ' files</span></div>';
    html += '<div class="vault-files">';
    data.files.forEach(function(f) {
      html += '<div class="vault-file"><input type="checkbox" checked data-path="' + escAttr(f.path) + '"><span class="vf-path" title="' + escAttr(f.path) + '">' + esc(f.path) + '</span><span class="vf-size">' + formatSize(f.size) + '</span></div>';
    });
    html += '</div>';
    html += '<div class="import-controls" style="margin-top:12px"><button onclick="startVaultImport()">Import Selected</button></div>';
    document.getElementById('vaultResults').innerHTML = html;
  } catch(err) { document.getElementById('vaultResults').innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
}

function toggleAllVault(checked) {
  document.querySelectorAll('.vault-file input[type="checkbox"]').forEach(function(cb) { cb.checked = checked; });
}

async function startVaultImport() {
  var path = document.getElementById('vaultPath').value.trim();
  var selected = [];
  document.querySelectorAll('.vault-file input[type="checkbox"]:checked').forEach(function(cb) { selected.push(cb.dataset.path); });
  if (selected.length === 0) { await modalAlert('No files selected', 'Import'); return; }
  try {
    var r = await fetch(API + '/import/obsidian/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path, files: selected }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    startProgressPoll();
  } catch(err) { await modalAlert(err.message, 'Import Error'); }
}

function startProgressPoll() {
  if (importPollTimer) clearInterval(importPollTimer);
  updateImportProgress();
  importPollTimer = setInterval(updateImportProgress, 2000);
}

async function updateImportProgress() {
  try {
    var r = await fetch(API + '/import/status');
    var p = await r.json();
    var pct = p.total > 0 ? Math.round(p.processed / p.total * 100) : 0;
    var html = '<div class="progress-box">';
    html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
    html += '<div class="progress-text">' + (p.running ? 'Importing...' : 'Done!') + ' ' + p.processed + '/' + p.total + ' (' + pct + '%)</div>';
    if (p.skipped > 0) html += '<div class="progress-detail">Skipped: ' + p.skipped + ' duplicates</div>';
    if (p.lastFile) html += '<div class="progress-detail">Last: ' + esc(p.lastFile) + '</div>';
    if (p.errors.length > 0) html += '<div class="progress-errors">Errors: ' + p.errors.map(esc).join('<br>') + '</div>';
    html += '</div>';
    document.getElementById('importProgress').innerHTML = html;
    if (!p.running && importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
  } catch(e) {}
}

// --- Activity ---
var activityToolFilter = '';
var TOOL_ICONS = {brain_save:'\ud83d\udcbe',brain_search:'\ud83d\udd0d',brain_recent:'\ud83d\udd53',brain_related:'\ud83d\udd17',brain_stats:'\ud83d\udcca',brain_tags:'\ud83c\udff7',brain_tag_rename:'\u270e',brain_delete:'\ud83d\uddd1'};

async function loadActivity() {
  document.getElementById('activityResults').innerHTML = '<div class="loading">Loading activity...</div>';
  try {
    var statsR = await fetch(API + '/activity/stats');
    var stats = await statsR.json();
    var sh = '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-value">' + stats.total_calls + '</div><div class="stat-label">Total calls</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + stats.today + '</div><div class="stat-label">Today</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + stats.avg_duration_ms + 'ms</div><div class="stat-label">Avg latency</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + Object.keys(stats.by_client || {}).length + '</div><div class="stat-label">Clients</div></div></div>';
    document.getElementById('activityStats').innerHTML = sh;

    // Filter chips
    var tools = Object.keys(stats.by_tool || {});
    var fh = '<button class="' + (!activityToolFilter ? 'active' : '') + '" onclick="activityToolFilter=\'\';loadActivity()">All</button>';
    tools.forEach(function(t) { fh += '<button class="' + (activityToolFilter === t ? 'active' : '') + '" onclick="activityToolFilter=\'' + escAttr(t) + '\';loadActivity()">' + esc(t.replace('brain_','')) + ' (' + stats.by_tool[t] + ')</button>'; });
    document.getElementById('activityFilters').innerHTML = fh;

    var url = API + '/activity?limit=50';
    if (activityToolFilter) url += '&tool=' + encodeURIComponent(activityToolFilter);
    var r = await fetch(url);
    var data = await r.json();
    if (!data.entries || data.entries.length === 0) {
      document.getElementById('activityResults').innerHTML = '<div class="empty">No activity yet. MCP tool calls will appear here.</div>';
      return;
    }
    document.getElementById('activityResults').innerHTML = data.entries.map(function(e) {
      var icon = TOOL_ICONS[e.tool_name] || '\u2699';
      var time = e.created_at ? new Date(e.created_at).toLocaleTimeString() : '';
      var date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
      return '<div class="activity-entry' + (e.status === 'error' ? ' error' : '') + '">' +
        '<div class="activity-icon">' + icon + '</div>' +
        '<div class="activity-body">' +
          '<div class="activity-header">' +
            '<span class="activity-tool">' + esc(e.tool_name) + '</span>' +
            (e.client_name ? '<span class="activity-client">' + esc(e.client_name) + '</span>' : '') +
            '<span class="activity-duration">' + (e.duration_ms || 0) + 'ms</span>' +
            '<span class="activity-time">' + date + ' ' + time + '</span>' +
          '</div>' +
          (e.input_summary ? '<div class="activity-summary">' + esc(e.input_summary) + '</div>' : '') +
          (e.output_summary && e.status !== 'error' ? '<div class="activity-output">' + esc(e.output_summary) + '</div>' : '') +
          (e.error_message ? '<div class="activity-error">' + esc(e.error_message) + '</div>' : '') +
        '</div></div>';
    }).join('');
  } catch(e) { document.getElementById('activityResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Brain Status ---
async function loadBrainStatus() {
  document.getElementById('statsContent').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var [statusRes, statsRes, orphanRes] = await Promise.all([
      fetch(API + '/brain/status'),
      fetch(API + '/stats'),
      fetch(API + '/tags/orphans').catch(function() { return null; }),
    ]);
    var status = await statusRes.json();
    var s = await statsRes.json();
    var orphanData = orphanRes ? await orphanRes.json() : null;

    var html = '';

    // Stream section
    html += '<div class="status-section"><h3>Stream</h3><div class="status-grid">';
    html += '<div class="stat-card"><div class="stat-value">' + status.stream.total_blocks + '</div><div class="stat-label">Total blocks</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.stream.pending_blocks + '</div><div class="stat-label">Pending</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.stream.distilled_blocks + '</div><div class="stat-label">Distilled</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.stream.pinned_blocks + '</div><div class="stat-label">Pinned</div></div>';
    if (status.stream.expiring_soon > 0) {
      html += '<div class="stat-card"><div class="stat-value status-warning">' + status.stream.expiring_soon + '</div><div class="stat-label status-warning">Expiring &lt;3d</div></div>';
    }
    html += '</div></div>';

    // Distillation section
    html += '<div class="status-section"><h3>Distillation</h3><div class="status-grid">';
    if (status.distillation.last_run) {
      var lr = status.distillation.last_run;
      html += '<div class="stat-card"><div class="stat-value">' + timeAgo(lr.created_at) + '</div><div class="stat-label">Last run (' + esc(lr.trigger) + ')</div></div>';
      html += '<div class="stat-card"><div class="stat-value">' + lr.thoughts_created + '</div><div class="stat-label">Thoughts created</div></div>';
      html += '<div class="stat-card"><div class="stat-value">$' + lr.estimated_cost.toFixed(4) + '</div><div class="stat-label">Last cost</div></div>';
    } else {
      html += '<div class="stat-card"><div class="stat-value">-</div><div class="stat-label">No runs yet</div></div>';
    }
    if (status.distillation.next_run) {
      var next = new Date(status.distillation.next_run);
      html += '<div class="stat-card"><div class="stat-value">' + next.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit'}) + '</div><div class="stat-label">Next cron</div></div>';
    }
    html += '<div class="stat-card"><div class="stat-value">' + status.distillation.weekly_thoughts + '</div><div class="stat-label">This week</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.distillation.conversion_rate + '</div><div class="stat-label">Conversion rate</div></div>';
    html += '<div class="stat-card"><div class="stat-value">$' + status.distillation.cost_7d.toFixed(4) + '</div><div class="stat-label">7d cost</div></div>';
    html += '<div class="stat-card"><div class="stat-value">$' + status.distillation.cost_30d.toFixed(4) + '</div><div class="stat-label">30d cost</div></div>';
    html += '</div>';

    // No recent run warning
    if (status.distillation.last_run) {
      var lastRunTime = new Date(status.distillation.last_run.created_at).getTime();
      if (Date.now() - lastRunTime > 48 * 60 * 60 * 1000) {
        html += '<p class="status-warning" style="margin-top:8px;font-size:13px">No distillation run in the last 48 hours</p>';
      }
    }
    html += '</div>';

    // Thoughts section
    html += '<div class="status-section"><h3>Thoughts</h3><div class="status-grid">';
    html += '<div class="stat-card"><div class="stat-value">' + status.thoughts.total + '</div><div class="stat-label">Total</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.thoughts.last_7_days + '</div><div class="stat-label">Last 7 days</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + status.thoughts.last_30_days + '</div><div class="stat-label">Last 30 days</div></div>';
    html += '</div>';
    if (status.thoughts.by_source) {
      html += '<h4 style="margin:12px 0 8px;color:#888;font-size:13px">By Source</h4><div class="status-grid">';
      for (var k in status.thoughts.by_source) html += '<div class="stat-card"><div class="stat-value">' + status.thoughts.by_source[k] + '</div><div class="stat-label">' + esc(k) + '</div></div>';
      html += '</div>';
    }
    if (s.by_type) {
      html += '<h4 style="margin:12px 0 8px;color:#888;font-size:13px">By Type</h4><div class="status-grid">';
      for (var k2 in s.by_type) html += '<div class="stat-card"><div class="stat-value">' + s.by_type[k2] + '</div><div class="stat-label">' + esc(k2) + '</div></div>';
      html += '</div>';
    }
    html += '</div>';

    // Orphan tags
    if (orphanData && orphanData.orphans && orphanData.orphans.length > 0) {
      html += '<div class="status-section"><h3>Orphan Tags (' + orphanData.total + ')</h3>';
      orphanData.orphans.forEach(function(o) {
        var st = escAttr(o.tag), si = o.thought ? escAttr(o.thought.id) : '';
        html += '<div class="orphan-item" data-id="' + si + '"><div class="orphan-info"><span class="tag">' + esc(o.tag) + '</span>';
        if (o.thought) html += '<span class="orphan-thought">' + esc(o.thought.title || 'Untitled') + '</span>';
        html += '</div><div class="thought-actions"><button data-action="rename-orphan" data-tag="' + st + '" title="Rename">&#9998;</button>';
        if (o.thought) html += '<button data-action="remove-orphan" data-tag="' + st + '" data-thought-id="' + si + '" title="Remove">&#10005;</button>';
        html += '</div></div>';
      });
      html += '</div>';
    }

    document.getElementById('statsContent').innerHTML = html;
    document.getElementById('totalCount').textContent = status.thoughts.total + ' thoughts';
  } catch(e) { document.getElementById('statsContent').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Distill Log ---
var distillLogLimit = 10;

async function loadDistillLog() {
  // Update limit button states
  document.querySelectorAll('.distill-limit-selector button').forEach(function(b) {
    b.classList.toggle('active', parseInt(b.textContent) === distillLogLimit);
  });
  document.getElementById('distillLogResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var r = await fetch(API + '/distillation/log?limit=' + distillLogLimit);
    var data = await r.json();
    if (!data.runs || data.runs.length === 0) {
      document.getElementById('distillLogResults').innerHTML = '<div class="empty">No distillation runs yet</div>';
      return;
    }
    document.getElementById('distillLogResults').innerHTML = data.runs.map(function(run, idx) {
      var date = run.created_at ? new Date(run.created_at).toLocaleString() : '';
      var thoughtLinks = (run.thought_ids || []).map(function(tid) {
        return '<a href="#" onclick="switchTab(\'recent\');return false;" title="' + escAttr(tid) + '">' + tid.slice(0, 8) + '…</a>';
      }).join('');
      var thoughtTitleLink = run.thoughts_created > 0
        ? '<a href="#" class="stream-thought-link" onclick="event.stopPropagation();showRunThoughts(\'' + run.id + '\');return false;">show titles</a>'
        : '';
      var skipReasons = '';
      if (run.blocks_skipped > 0) { try { var sr = JSON.parse(run.skip_reasons || '{}'); skipReasons = Object.entries(sr).map(function(e) { return e[0] + ': ' + e[1]; }).join(', '); } catch(e) {} }

      return '<div class="distill-run" onclick="this.querySelector(\'.distill-run-detail\').classList.toggle(\'open\')">' +
        '<div class="distill-run-header">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<span style="color:#fff;font-size:14px">' + esc(date) + '</span>' +
            '<span class="trigger-badge" data-trigger="' + escAttr(run.trigger) + '">' + esc(run.trigger) + '</span>' +
            '<span class="status-badge" data-status="' + escAttr(run.status) + '">' + esc(run.status) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="distill-run-stats">' +
          '<span>Blocks: ' + run.blocks_processed + '</span>' +
          '<span>Thoughts: ' + run.thoughts_created + '</span>' +
          '<span>Tokens: ' + run.tokens_used + '</span>' +
          '<span>Cost: $' + (run.estimated_cost || 0).toFixed(4) + '</span>' +
          '<span>' + (run.duration_ms || 0) + 'ms</span>' +
        '</div>' +
        '<div class="distill-run-detail">' +
          (run.thoughts_created > 0 ? '<div style="margin-bottom:6px;color:#aaa">Created thoughts: ' + thoughtTitleLink + '</div><div class="distill-run-thoughts">' + thoughtLinks + '</div>' : '') +
          (run.blocks_skipped > 0 ? '<div style="margin-top:6px">Skipped: ' + run.blocks_skipped + (skipReasons ? ' (' + esc(skipReasons) + ')' : '') + '</div>' : '') +
          (run.error_message ? '<div style="margin-top:6px;color:#a66">Error: ' + esc(run.error_message) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) { document.getElementById('distillLogResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// --- Run thoughts popup ---
async function showRunThoughts(runId) {
  try {
    var r = await fetch(API + '/distillation/log/' + encodeURIComponent(runId));
    var data = await r.json();
    if (!data.thought_ids || data.thought_ids.length === 0) {
      showToast('No thoughts created in this run');
      return;
    }
    var summaries = data.thought_summaries || [];
    var lines = summaries.map(function(s) {
      return (s.title || s.id.slice(0, 12));
    });
    await modalAlert('Thoughts created: ' + data.thought_ids.length + '\n\n' + lines.join('\n'), 'Distillation Run');
  } catch(e) { showToast('Error loading run details'); }
}

// --- Expiring blocks notification ---
async function checkExpiringBlocks() {
  try {
    var r = await fetch(API + '/brain/status');
    var status = await r.json();
    if (status.stream.expiring_soon > 0 && status.stream.pending_blocks > 0) {
      showToast(status.stream.expiring_soon + ' blocks expiring soon, not yet distilled', true);
    }
  } catch(e) { /* ignore */ }
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
      else { if (!wb) { wb = document.createElement('span'); wb.className = 'weight-badge'; card.querySelector('.thought-badges').insertBefore(wb, card.querySelector('.epistemic-badge')); } wb.textContent = '\u00d7' + data.weight; }
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
  [{key:'hypothesis',label:'? Hypothesis'},{key:'conviction',label:'! Conviction'},{key:'fact',label:'\u2713 Fact'},{key:'outdated',label:'\u2717 Outdated'},{key:'question',label:'? Question'},{key:'',label:'\u2014 Clear'}].forEach(function(item) {
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
    if (card) { var badge = card.querySelector('.epistemic-badge'); if (badge) { if (data.epistemic_status) { badge.dataset.status = data.epistemic_status; badge.textContent = STATUSES[data.epistemic_status] || data.epistemic_status; } else { delete badge.dataset.status; badge.textContent = '\u00b7'; } } }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

// --- Orphan tags ---
async function removeOrphanTag(tag, thoughtId) {
  if (!await modalConfirm('Remove tag "' + tag + '" from this thought?', { title: 'Remove Tag', okLabel: 'Remove' })) return;
  try { var r = await fetch(API + '/tags/' + encodeURIComponent(tag) + '/from/' + encodeURIComponent(thoughtId), { method: 'DELETE' }); if (!r.ok) throw new Error('Failed'); loadBrainStatus(); }
  catch(err) { await modalAlert(err.message, 'Error'); }
}
async function renameOrphanTag(oldTag) {
  var n = await modalPrompt('Enter new name for tag "' + oldTag + '":', oldTag, { title: 'Rename Tag', okLabel: 'Rename' });
  if (!n || n === oldTag) return;
  try { var r = await fetch(API + '/tags/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_tag: oldTag, new_tag: n }) }); if (!r.ok) throw new Error('Failed'); loadBrainStatus(); }
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

// --- Distillation ---
var distillationPollTimer = null;

function showToast(msg, warning) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('warning', !!warning);
  el.classList.add('visible');
  setTimeout(function() { el.classList.remove('visible'); el.classList.remove('warning'); }, 4000);
}

async function loadDistillationStatus() {
  try {
    var r = await fetch(API + '/distillation/status');
    var data = await r.json();
    var el = document.getElementById('distillationStatus');
    if (!el) return;

    if (data.running) {
      el.innerHTML = '<span class="running">Distilling...</span>';
      return;
    }
    if (data.last_run) {
      var ago = timeAgo(data.last_run.created_at);
      el.textContent = 'Last run: ' + ago + ', ' + data.last_run.thoughts_created + ' thoughts';
    } else {
      el.textContent = 'No distillation runs yet';
    }
  } catch(err) { /* ignore */ }
}

function timeAgo(isoDate) {
  if (!isoDate) return 'never';
  var diff = Date.now() - new Date(isoDate).getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

async function triggerPowerNap() {
  var btn = document.getElementById('powerNapBtn');
  btn.disabled = true;
  btn.textContent = 'Running...';

  try {
    var r = await fetch(API + '/distillation/run', { method: 'POST' });
    if (r.status === 409) {
      showToast('Distillation is already running');
      return;
    }
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }

    // Poll for completion
    distillationPollTimer = setInterval(async function() {
      try {
        var sr = await fetch(API + '/distillation/status');
        var status = await sr.json();
        if (!status.running) {
          clearInterval(distillationPollTimer);
          distillationPollTimer = null;
          btn.disabled = false;
          btn.textContent = 'Power Nap';
          if (status.last_run) {
            showToast('Extracted ' + status.last_run.thoughts_created + ' thoughts from ' + status.last_run.blocks_processed + ' blocks');
          }
          loadDistillationStatus();
          loadStream();
        }
      } catch(e) { /* ignore poll errors */ }
    }, 2000);
  } catch(err) {
    btn.disabled = false;
    btn.textContent = 'Power Nap';
    await modalAlert(err.message, 'Error');
  }
}

// --- Init ---
document.getElementById('searchInput').addEventListener('input', function(e) { clearTimeout(debounceTimer); debounceTimer = setTimeout(function() { search(e.target.value); }, 400); });
document.getElementById('searchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(debounceTimer); search(e.target.value); } });
document.getElementById('timelineInput').addEventListener('input', function(e) { clearTimeout(timelineTimer); timelineTimer = setTimeout(function() { searchTimeline(e.target.value); }, 600); });
document.getElementById('timelineInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(timelineTimer); searchTimeline(e.target.value); } });
document.getElementById('streamSearchInput').addEventListener('input', function(e) { clearTimeout(streamSearchTimer); streamSearchTimer = setTimeout(function() { loadStream(); }, 500); });
document.getElementById('streamSearchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(streamSearchTimer); loadStream(); } });
fetch(API + '/brain/status').then(function(r) { return r.json(); }).then(function(s) { document.getElementById('totalCount').textContent = s.thoughts.total + ' thoughts'; }).catch(function() {});
setupDropZone();
