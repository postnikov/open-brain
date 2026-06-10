import { API, esc, escAttr, timeAgo, showToast } from './helpers.js';

export async function loadBrainStatus() {
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

export async function checkExpiringBlocks() {
  try {
    var r = await fetch(API + '/brain/status');
    var status = await r.json();
    if (status.stream.expiring_soon > 0 && status.stream.pending_blocks > 0) {
      showToast(status.stream.expiring_soon + ' blocks expiring soon, not yet distilled', true);
    }
  } catch(e) { /* ignore */ }
}
