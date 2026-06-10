import { API, esc, escAttr, timeAgo, showToast } from './helpers.js';
import { modalAlert } from './modal.js';
import { loadStream } from './stream.js';

let distillLogLimit = 10;
let distillationPollTimer = null;

export function setDistillLogLimit(limit) {
  distillLogLimit = limit;
  loadDistillLog();
}

export async function loadDistillLog() {
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

export async function showRunThoughts(runId) {
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

export async function loadDistillationStatus() {
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

export async function triggerPowerNap() {
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
