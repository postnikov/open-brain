import { API, esc, escAttr } from './helpers.js';
import { modalConfirm, modalAlert } from './modal.js';

export async function loadDuplicates() {
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
            '<div class="dup-side-meta">' + esc(a.source) + ' · ' + aDate + '</div>' +
            '<div class="dup-side-tags">' + aTags + '</div></div>' +
          '<div class="dup-side"><div class="dup-side-title">' + esc(b.title || 'Untitled') + '</div>' +
            '<div class="dup-side-content">' + esc(b.content) + '</div>' +
            '<div class="dup-side-meta">' + esc(b.source) + ' · ' + bDate + '</div>' +
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

export async function dupKeep(keepId, removeId) {
  if (!await modalConfirm('Delete the other thought permanently?', { title: 'Keep One', okLabel: 'Delete' })) return;
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(removeId), { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadDuplicates();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function dupDismiss(idA, idB, btn) {
  try {
    var r = await fetch(API + '/duplicates/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_a: idA, id_b: idB }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    var pair = btn.closest('.dup-pair');
    if (pair) { pair.style.opacity = '0'; pair.style.transition = 'opacity 0.3s'; setTimeout(function() { pair.remove(); }, 300); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function dupMerge(keepId, removeId) {
  if (!await modalConfirm('Merge tags/topics into kept thought and delete the other?', { title: 'Merge Thoughts', okLabel: 'Merge' })) return;
  try {
    var r = await fetch(API + '/duplicates/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep_id: keepId, remove_id: removeId }) });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    loadDuplicates();
  } catch(err) { await modalAlert(err.message, 'Error'); }
}
