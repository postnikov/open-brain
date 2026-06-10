import { API, esc } from './helpers.js';
import { modalConfirm, modalAlert, modalPrompt } from './modal.js';
import { renderThought, STATUSES } from './render.js';
import { loadBrainStatus } from './status.js';

let reviewDaysAgo = 7;

export function reviewEarlier() { reviewDaysAgo += 7; loadReview(); }
export function reviewLater() { reviewDaysAgo = Math.max(1, reviewDaysAgo - 7); loadReview(); }

export async function loadRecent(source) {
  document.getElementById('recentResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var url = API + '/recent?limit=50';
    if (source) url += '&source=' + encodeURIComponent(source);
    var r = await fetch(url);
    var data = await r.json();
    document.getElementById('recentResults').innerHTML = data.thoughts.map(function(t) { return renderThought(t); }).join('');
  } catch(e) { document.getElementById('recentResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

export async function loadReview() {
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
      '<p style="color:#666;font-size:13px;margin-bottom:16px">' + data.period.from + ' — ' + data.period.to + ' · ' + data.total + ' thoughts</p>' +
      data.thoughts.map(function(t) { return renderThought(t, {review: true}); }).join('');
  } catch(e) { document.getElementById('reviewResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

export async function loadCompost() {
  document.getElementById('compostResults').innerHTML = '<div class="loading">Loading...</div>';
  try {
    var r = await fetch(API + '/compost');
    var data = await r.json();
    if (!data.thoughts || data.thoughts.length === 0) { document.getElementById('compostResults').innerHTML = '<div class="empty">Compost is empty.</div>'; return; }
    document.getElementById('compostResults').innerHTML = data.thoughts.map(function(t) { return renderThought(t, {composted: true, days_remaining: t.days_remaining}); }).join('');
  } catch(e) { document.getElementById('compostResults').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

export async function deleteThought(id) {
  if (!await modalConfirm('Delete this thought permanently?', { title: 'Delete Thought', okLabel: 'Delete' })) return;
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  if (card) card.style.opacity = '0.5';
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(20px)'; card.style.maxHeight = '0'; card.style.overflow = 'hidden'; card.style.marginBottom = '0'; card.style.padding = '0'; setTimeout(function() { card.remove(); }, 350); }
  } catch (err) { if (card) card.style.opacity = '1'; await modalAlert(err.message, 'Error'); }
}

export async function adjustWeight(id, direction) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/weight', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: direction }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    if (card) {
      var wb = card.querySelector('.weight-badge');
      if (data.weight === 1) { if (wb) wb.remove(); }
      else { if (!wb) { wb = document.createElement('span'); wb.className = 'weight-badge'; card.querySelector('.thought-badges').insertBefore(wb, card.querySelector('.epistemic-badge')); } wb.textContent = '×' + data.weight; }
      card.style.opacity = Math.min(Math.max(0.4 + data.weight * 0.06, 0.5), 1.0);
    }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function compostThought(id) {
  if (!await modalConfirm('Send this thought to compost? It will dissolve in 30 days.', { title: 'Compost', okLabel: 'Compost' })) return;
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/compost', { method: 'POST' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(-20px)'; card.style.maxHeight = '0'; card.style.overflow = 'hidden'; card.style.marginBottom = '0'; card.style.padding = '0'; setTimeout(function() { card.remove(); }, 350); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function restoreThought(id) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(20px)'; setTimeout(function() { card.remove(); }, 350); }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export function showStatusMenu(badge, id) {
  var existing = document.querySelector('.status-menu'); if (existing) { existing.remove(); return; }
  var menu = document.createElement('div'); menu.className = 'status-menu';
  [{key:'hypothesis',label:'? Hypothesis'},{key:'conviction',label:'! Conviction'},{key:'fact',label:'✓ Fact'},{key:'outdated',label:'✗ Outdated'},{key:'question',label:'? Question'},{key:'',label:'— Clear'}].forEach(function(item) {
    var div = document.createElement('div'); div.className = 'status-menu-item'; div.textContent = item.label; div.dataset.action = 'set-status'; div.dataset.status = item.key; menu.appendChild(div);
  });
  badge.style.position = 'relative'; badge.appendChild(menu);
}

export async function setStatus(id, status) {
  var existing = document.querySelector('.status-menu'); if (existing) existing.remove();
  try {
    var r = await fetch(API + '/thoughts/' + encodeURIComponent(id) + '/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status || null }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]');
    if (card) { var badge = card.querySelector('.epistemic-badge'); if (badge) { if (data.epistemic_status) { badge.dataset.status = data.epistemic_status; badge.textContent = STATUSES[data.epistemic_status] || data.epistemic_status; } else { delete badge.dataset.status; badge.textContent = '·'; } } }
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function removeOrphanTag(tag, thoughtId) {
  if (!await modalConfirm('Remove tag "' + tag + '" from this thought?', { title: 'Remove Tag', okLabel: 'Remove' })) return;
  try { var r = await fetch(API + '/tags/' + encodeURIComponent(tag) + '/from/' + encodeURIComponent(thoughtId), { method: 'DELETE' }); if (!r.ok) throw new Error('Failed'); loadBrainStatus(); }
  catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function renameOrphanTag(oldTag) {
  var n = await modalPrompt('Enter new name for tag "' + oldTag + '":', oldTag, { title: 'Rename Tag', okLabel: 'Rename' });
  if (!n || n === oldTag) return;
  try { var r = await fetch(API + '/tags/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_tag: oldTag, new_tag: n }) }); if (!r.ok) throw new Error('Failed'); loadBrainStatus(); }
  catch(err) { await modalAlert(err.message, 'Error'); }
}

export function startEdit(id) {
  var card = document.querySelector('.thought[data-id="' + CSS.escape(id) + '"]'); if (!card || card.classList.contains('editing')) return;
  var te = card.querySelector('.thought-title'), ce = card.querySelector('.thought-content'), tge = card.querySelector('.thought-tags');
  var ot = te.textContent || '', oc = ce.textContent || '', otg = Array.from(tge.querySelectorAll('.tag')).map(function(t) { return t.textContent; });
  card.dataset.origTitle = ot; card.dataset.origContent = oc; card.dataset.origTags = JSON.stringify(otg); card.classList.add('editing');
  var ti = document.createElement('input'); ti.className = 'edit-title'; ti.value = ot; te.textContent = ''; te.appendChild(ti);
  ce.classList.remove('collapsed'); var ca = document.createElement('textarea'); ca.className = 'edit-content'; ca.value = oc; ce.textContent = ''; ce.appendChild(ca);
  var tgi = document.createElement('input'); tgi.className = 'edit-tags'; tgi.value = otg.join(', '); tgi.placeholder = 'Tags (comma-separated)'; tge.textContent = ''; tge.appendChild(tgi);
  var eb = document.createElement('div'); eb.className = 'edit-actions'; eb.innerHTML = '<button class="btn-save" data-action="save-edit">Save</button><button class="btn-cancel" data-action="cancel-edit">Cancel</button><span class="edit-status"></span>'; card.appendChild(eb);
}

export async function saveEdit(id) {
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

export function cancelEdit(btn) { var c = btn.closest('.thought'); if (!c) return; finishEdit(c, { title: c.dataset.origTitle, content: c.dataset.origContent, tags: JSON.parse(c.dataset.origTags || '[]') }); }

export function finishEdit(card, data) {
  card.classList.remove('editing'); var eb = card.querySelector('.edit-actions'); if (eb) eb.remove();
  card.querySelector('.thought-title').textContent = data.title || 'Untitled';
  var ce = card.querySelector('.thought-content'); ce.textContent = data.content; if (data.content && data.content.length > 200) ce.classList.add('collapsed');
  card.querySelector('.thought-tags').innerHTML = (data.tags || []).map(function(tag) { return '<span class="tag">' + esc(tag) + '</span>'; }).join('');
  delete card.dataset.origTitle; delete card.dataset.origContent; delete card.dataset.origTags;
}
