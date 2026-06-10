import { API, esc, escAttr } from './helpers.js';

let activityToolFilter = '';
const TOOL_ICONS = {brain_save:'💾',brain_search:'🔍',brain_recent:'🕓',brain_related:'🔗',brain_stats:'📊',brain_tags:'🏷',brain_tag_rename:'✎',brain_delete:'🗑'};

export function setActivityFilter(tool) {
  activityToolFilter = tool;
  loadActivity();
}

export async function loadActivity() {
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
    var fh = '<button class="' + (!activityToolFilter ? 'active' : '') + '" onclick="setActivityFilter(\'\')">All</button>';
    tools.forEach(function(t) { fh += '<button class="' + (activityToolFilter === t ? 'active' : '') + '" onclick="setActivityFilter(\'' + escAttr(t) + '\')">' + esc(t.replace('brain_','')) + ' (' + stats.by_tool[t] + ')</button>'; });
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
      var icon = TOOL_ICONS[e.tool_name] || '⚙';
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
