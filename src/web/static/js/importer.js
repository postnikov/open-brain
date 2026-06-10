import { API, esc, escAttr, formatSize } from './helpers.js';
import { modalAlert } from './modal.js';

let pendingFiles = [];
let importPollTimer = null;

export function setupDropZone() {
  var dz = document.getElementById('dropZone');
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function(e) { e.preventDefault(); dz.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
  document.getElementById('fileInput').addEventListener('change', function(e) { addFiles(e.target.files); e.target.value = ''; });
}

export function addFiles(fileList) {
  Array.from(fileList).forEach(function(f) {
    if (!f.name.match(/\.(md|txt)$/i)) return;
    var reader = new FileReader();
    reader.onload = function() {
      pendingFiles.push({ name: f.name, content: reader.result, size: f.size });
      renderPendingFiles();
    };
    reader.readAsText(f);
  });
}

export function renderPendingFiles() {
  var el = document.getElementById('uploadFileList');
  if (pendingFiles.length === 0) { el.innerHTML = ''; document.getElementById('uploadControls').style.display = 'none'; return; }
  document.getElementById('uploadControls').style.display = 'flex';
  document.getElementById('uploadBtn').textContent = 'Import ' + pendingFiles.length + ' file' + (pendingFiles.length > 1 ? 's' : '');
  el.innerHTML = pendingFiles.map(function(f, i) {
    return '<div class="file-item"><span class="file-name">' + esc(f.name) + '</span><span class="file-size">' + formatSize(f.size) + '</span><button onclick="removePendingFile(' + i + ')">✕</button></div>';
  }).join('');
}

export function removePendingFile(i) { pendingFiles.splice(i, 1); renderPendingFiles(); }

export async function startFileUpload() {
  if (pendingFiles.length === 0) return;
  var source = document.getElementById('uploadSource').value;
  var files = pendingFiles.map(function(f) { return { name: f.name, content: f.content }; });
  try {
    var r = await fetch(API + '/import/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: files, source: source }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    pendingFiles = [];
    renderPendingFiles();
    startProgressPoll();
  } catch(err) { await modalAlert(err.message, 'Import Error'); }
}

export async function scanVault() {
  var path = document.getElementById('vaultPath').value.trim();
  if (!path) return;
  document.getElementById('vaultResults').innerHTML = '<div class="loading">Scanning...</div>';
  try {
    var r = await fetch(API + '/import/obsidian/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Scan failed');
    if (data.files.length === 0) { document.getElementById('vaultResults').innerHTML = '<div class="empty">No .md files found in this path</div>'; return; }
    var html = '<div style="display:flex;gap:8px;margin:12px 0"><button onclick="toggleAllVault(true)">Select All</button><button onclick="toggleAllVault(false)">Clear</button><span style="color:#666;font-size:12px;line-height:28px">' + data.total + ' files</span></div>';
    html += '<div class="vault-files">';
    data.files.forEach(function(f) {
      html += '<div class="vault-file"><input type="checkbox" checked data-path="' + escAttr(f.path) + '"><span class="vf-path" title="' + escAttr(f.path) + '">' + esc(f.path) + '</span><span class="vf-size">' + formatSize(f.size) + '</span></div>';
    });
    html += '</div>';
    html += '<div class="import-controls" style="margin-top:12px"><button onclick="startVaultImport()">Import Selected</button></div>';
    document.getElementById('vaultResults').innerHTML = html;
  } catch(err) { document.getElementById('vaultResults').innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
}

export function toggleAllVault(checked) {
  document.querySelectorAll('.vault-file input[type="checkbox"]').forEach(function(cb) { cb.checked = checked; });
}

export async function startVaultImport() {
  var path = document.getElementById('vaultPath').value.trim();
  var selected = [];
  document.querySelectorAll('.vault-file input[type="checkbox"]:checked').forEach(function(cb) { selected.push(cb.dataset.path); });
  if (selected.length === 0) { await modalAlert('No files selected', 'Import'); return; }
  try {
    var r = await fetch(API + '/import/obsidian/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path, files: selected }) });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    startProgressPoll();
  } catch(err) { await modalAlert(err.message, 'Import Error'); }
}

export function startProgressPoll() {
  if (importPollTimer) clearInterval(importPollTimer);
  updateImportProgress();
  importPollTimer = setInterval(updateImportProgress, 2000);
}

export async function updateImportProgress() {
  try {
    var r = await fetch(API + '/import/status');
    var p = await r.json();
    var pct = p.total > 0 ? Math.round(p.processed / p.total * 100) : 0;
    var html = '<div class="progress-box">';
    html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
    html += '<div class="progress-text">' + (p.running ? 'Importing...' : 'Done!') + ' ' + p.processed + '/' + p.total + ' (' + pct + '%)</div>';
    if (p.skipped > 0) html += '<div class="progress-detail">Skipped: ' + p.skipped + ' duplicates</div>';
    if (p.lastFile) html += '<div class="progress-detail">Last: ' + esc(p.lastFile) + '</div>';
    if (p.errors.length > 0) html += '<div class="progress-errors">Errors: ' + p.errors.map(esc).join('<br>') + '</div>';
    html += '</div>';
    document.getElementById('importProgress').innerHTML = html;
    if (!p.running && importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
  } catch(e) {}
}
