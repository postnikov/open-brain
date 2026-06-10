import { esc, escAttr } from './helpers.js';
import { selectedIds } from './batch.js';

export const STATUSES = {hypothesis:'? Hypothesis',conviction:'! Conviction',fact:'✓ Fact',outdated:'✗ Outdated',question:'? Question'};

export function renderThought(t, opts) {
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
  if (t.weight && t.weight !== 1) badges += '<span class="weight-badge">×' + t.weight + '</span>';
  if (t.epistemic_status) badges += '<span class="epistemic-badge" data-action="toggle-status" data-status="' + escAttr(t.epistemic_status) + '">' + esc(STATUSES[t.epistemic_status] || t.epistemic_status) + '</span>';
  else badges += '<span class="epistemic-badge" data-action="toggle-status" title="Set status">·</span>';
  if (opts.days_remaining !== undefined) badges += '<span class="days-badge">' + opts.days_remaining + 'd left</span>';

  var actions = '';
  if (opts.composted) {
    actions = '<button data-action="restore" title="Restore">↩</button><button data-action="delete" title="Delete permanently">🗑</button>';
  } else if (opts.review) {
    actions = '<button class="review-true" data-action="amplify" title="Still true">✓ True</button>' +
      '<button data-action="edit" title="Evolved">✎ Evolved</button>' +
      '<button class="review-letgo" data-action="compost" title="Let go">🌱 Let go</button>';
  } else {
    actions = '<button data-action="fade" title="Fade">▼</button><button data-action="amplify" title="Amplify">▲</button>' +
      '<button data-action="edit" title="Edit">✎</button><button data-action="compost" title="Compost">🌱</button>' +
      '<button data-action="delete" title="Delete">🗑</button>';
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
