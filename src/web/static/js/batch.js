import { API } from './helpers.js';
import { modalConfirm, modalAlert, modalPrompt } from './modal.js';
import { switchTab } from './tabs.js';

export let batchMode = false;
export const selectedIds = new Set();

export function toggleBatchMode() {
  batchMode = !batchMode;
  document.getElementById('batchToggle').classList.toggle('active', batchMode);
  document.getElementById('batchToggle').textContent = batchMode ? 'Done' : 'Select';
  if (!batchMode) { batchClear(); }
  document.getElementById('batchToolbar').classList.toggle('visible', batchMode);
}

export function updateBatchCount() {
  document.getElementById('batchCount').textContent = selectedIds.size + ' selected';
  document.getElementById('batchToolbar').classList.toggle('visible', batchMode && selectedIds.size > 0);
}

export function batchSelectAll() {
  document.querySelectorAll('.thought[data-id]').forEach(function(c) { selectedIds.add(c.dataset.id); c.classList.add('selected'); });
  updateBatchCount();
}

export function batchClear() {
  selectedIds.clear();
  document.querySelectorAll('.thought.selected').forEach(function(c) { c.classList.remove('selected'); });
  updateBatchCount();
}

export async function batchAction(action) {
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

export async function batchAddTag() {
  if (selectedIds.size === 0) return;
  var tag = await modalPrompt('Add tag to ' + selectedIds.size + ' thoughts:', '', { title: 'Add Tag', okLabel: 'Add' });
  if (!tag) return;
  try {
    var r = await fetch(API + '/thoughts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action: 'add_tag', params: { tag: tag } }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    batchClear(); var activeTab = document.querySelector('.tab.active'); if (activeTab) switchTab(activeTab.dataset.tab);
  } catch(err) { await modalAlert(err.message, 'Error'); }
}

export async function batchSetStatus() {
  if (selectedIds.size === 0) return;
  var status = await modalPrompt('Set status (hypothesis / conviction / fact / outdated / question):', '', { title: 'Set Status', okLabel: 'Set' });
  if (!status) return;
  try {
    var r = await fetch(API + '/thoughts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action: 'set_status', params: { status: status } }) });
    var data = await r.json(); if (!r.ok) throw new Error(data.error || 'Failed');
    batchClear(); var activeTab = document.querySelector('.tab.active'); if (activeTab) switchTab(activeTab.dataset.tab);
  } catch(err) { await modalAlert(err.message, 'Error'); }
}
