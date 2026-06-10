import { API, esc } from './helpers.js';
import { renderThought } from './render.js';

export async function search(query) {
  if (!query.trim()) { document.getElementById('searchResults').innerHTML = ''; return; }
  document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...</div>';
  try {
    var r = await fetch(API + '/search?q=' + encodeURIComponent(query) + '&limit=20');
    var data = await r.json();
    if (!data.results || data.results.length === 0) { document.getElementById('searchResults').innerHTML = '<div class="empty">No results</div>'; return; }
    document.getElementById('searchResults').innerHTML = data.results.map(function(r) { return renderThought(r, {similarity: r.similarity}); }).join('');
  } catch(e) { document.getElementById('searchResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

export async function searchTimeline(query) {
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
