import { API, esc, escAttr } from './helpers.js';
import { modalConfirm, modalAlert } from './modal.js';

export async function loadStream() {
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
      var name = s.topic || s.session_id.slice(0, 16);
      if (name.length > 60) name = name.slice(0, 60) + '…';
      var label = name + ' (' + s.block_count + ')';
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

export async function toggleStreamPin(id, pinned) {
  try {
    var r = await fetch(API + '/stream/' + id + '/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: pinned }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadStream();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function deleteStreamBlock(id) {
  if (!await modalConfirm('Delete this stream block?', { title: 'Delete Block', okLabel: 'Delete' })) return;
  try {
    var r = await fetch(API + '/stream/' + id, { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadStream();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}
