import { esc, escAttr } from './helpers.js';

export function showModal(opts) {
  return new Promise(function(resolve) {
    var root = document.getElementById('modalRoot');
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal';
    var html = '';
    if (opts.title) html += '<div class="modal-title">' + esc(opts.title) + '</div>';
    if (opts.message) html += '<div class="modal-body">' + esc(opts.message) + '</div>';
    if (opts.input !== undefined) {
      html += '<input class="modal-input" id="modalInput" value="' + escAttr(opts.input) + '" placeholder="' + escAttr(opts.placeholder || '') + '" />';
    }
    html += '<div class="modal-buttons">';
    if (opts.type !== 'alert') {
      html += '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>';
    }
    var btnClass = opts.danger ? 'modal-btn-danger' : (opts.type === 'alert' ? 'modal-btn-ok' : 'modal-btn-confirm');
    html += '<button class="modal-btn ' + btnClass + '" id="modalOk">' + esc(opts.okLabel || 'OK') + '</button>';
    html += '</div>';
    modal.innerHTML = html;
    overlay.appendChild(modal);
    root.appendChild(overlay);

    var inp = modal.querySelector('#modalInput');
    if (inp) { inp.focus(); inp.select(); } else { modal.querySelector('#modalOk').focus(); }

    function close(val) { overlay.remove(); resolve(val); }

    modal.querySelector('#modalOk').onclick = function() {
      if (opts.input !== undefined) close(inp.value);
      else close(true);
    };
    var cancelBtn = modal.querySelector('#modalCancel');
    if (cancelBtn) cancelBtn.onclick = function() { close(opts.input !== undefined ? null : false); };
    overlay.onclick = function(e) { if (e.target === overlay) close(opts.input !== undefined ? null : false); };
    if (inp) inp.onkeydown = function(e) { if (e.key === 'Enter') modal.querySelector('#modalOk').click(); if (e.key === 'Escape') close(null); };
    modal.onkeydown = function(e) { if (e.key === 'Escape') close(opts.input !== undefined ? null : false); };
  });
}

export function modalConfirm(message, opts) {
  return showModal(Object.assign({ type: 'confirm', title: (opts && opts.title) || 'Confirm', message: message, danger: true, okLabel: (opts && opts.okLabel) || 'Confirm' }, opts || {}));
}

export function modalAlert(message, title) {
  return showModal({ type: 'alert', title: title || 'Notice', message: message, okLabel: 'OK' });
}

export function modalPrompt(message, defaultVal, opts) {
  return showModal(Object.assign({ type: 'prompt', title: (opts && opts.title) || 'Input', message: message, input: defaultVal || '', okLabel: (opts && opts.okLabel) || 'OK' }, opts || {}));
}
