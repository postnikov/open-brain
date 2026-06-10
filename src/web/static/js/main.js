import { API } from './helpers.js';
import { switchTab } from './tabs.js';
import { search, searchTimeline } from './search.js';
import {
  reviewEarlier, reviewLater,
  deleteThought, adjustWeight, compostThought, restoreThought,
  showStatusMenu, setStatus, removeOrphanTag, renameOrphanTag,
  startEdit, saveEdit, cancelEdit,
} from './thoughts.js';
import { dupKeep, dupDismiss, dupMerge } from './duplicates.js';
import { loadStream, toggleStreamPin, deleteStreamBlock } from './stream.js';
import {
  setupDropZone, removePendingFile, startFileUpload,
  scanVault, toggleAllVault, startVaultImport,
} from './importer.js';
import { setActivityFilter } from './activity.js';
import { setDistillLogLimit, showRunThoughts, triggerPowerNap } from './distill.js';
import {
  batchMode, selectedIds, toggleBatchMode, updateBatchCount,
  batchSelectAll, batchClear, batchAction, batchAddTag, batchSetStatus,
} from './batch.js';

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
    if (action === 'review-earlier') reviewEarlier();
    if (action === 'review-later') reviewLater();
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

// --- Window bindings for inline handlers (index.html + HTML generated in modules) ---
Object.assign(window, {
  switchTab,
  loadStream,
  triggerPowerNap,
  startFileUpload,
  scanVault,
  setDistillLogLimit,
  toggleStreamPin,
  deleteStreamBlock,
  showRunThoughts,
  removePendingFile,
  toggleAllVault,
  startVaultImport,
  setActivityFilter,
});

// --- Init ---
var debounceTimer, timelineTimer, streamSearchTimer;

document.getElementById('searchInput').addEventListener('input', function(e) { clearTimeout(debounceTimer); debounceTimer = setTimeout(function() { search(e.target.value); }, 400); });
document.getElementById('searchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(debounceTimer); search(e.target.value); } });
document.getElementById('timelineInput').addEventListener('input', function(e) { clearTimeout(timelineTimer); timelineTimer = setTimeout(function() { searchTimeline(e.target.value); }, 600); });
document.getElementById('timelineInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(timelineTimer); searchTimeline(e.target.value); } });
document.getElementById('streamSearchInput').addEventListener('input', function(e) { clearTimeout(streamSearchTimer); streamSearchTimer = setTimeout(function() { loadStream(); }, 500); });
document.getElementById('streamSearchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') { clearTimeout(streamSearchTimer); loadStream(); } });
fetch(API + '/brain/status').then(function(r) { return r.json(); }).then(function(s) { document.getElementById('totalCount').textContent = s.thoughts.total + ' thoughts'; }).catch(function() {});
setupDropZone();
