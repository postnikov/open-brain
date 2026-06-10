export const API = '/api';

export function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
export function escAttr(s) { return esc(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

export function timeAgo(isoDate) {
  if (!isoDate) return 'never';
  var diff = Date.now() - new Date(isoDate).getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

export function showToast(msg, warning) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('warning', !!warning);
  el.classList.add('visible');
  setTimeout(function() { el.classList.remove('visible'); el.classList.remove('warning'); }, 4000);
}
