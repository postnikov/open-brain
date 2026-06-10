import { loadRecent, loadReview, loadCompost } from './thoughts.js';
import { loadDuplicates } from './duplicates.js';
import { loadStream } from './stream.js';
import { loadActivity } from './activity.js';
import { loadBrainStatus, checkExpiringBlocks } from './status.js';
import { loadDistillLog, loadDistillationStatus } from './distill.js';

export const TABS = ['search','timeline','recent','review','compost','duplicates','stream','import','activity','stats','distill-log'];

export function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
  TABS.forEach(function(v) { document.getElementById(v + '-view').style.display = v === tab ? '' : 'none'; });
  if (tab === 'recent') loadRecent();
  if (tab === 'compost') loadCompost();
  if (tab === 'duplicates') loadDuplicates();
  if (tab === 'stream') { loadStream(); loadDistillationStatus(); checkExpiringBlocks(); }
  if (tab === 'activity') loadActivity();
  if (tab === 'stats') loadBrainStatus();
  if (tab === 'review') loadReview();
  if (tab === 'distill-log') loadDistillLog();
}
