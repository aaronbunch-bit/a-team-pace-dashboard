/**
 * Branded confirm / alert / prompt dialogs for A-Team Pacer.
 * Loaded before the main dashboard script; exposes window.uiDialog.
 */
(function () {
  function ensureHost() {
    let backdrop = document.getElementById('uiDialogBackdrop');
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.id = 'uiDialogBackdrop';
    backdrop.className = 'ui-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="uiDialogTitle">
        <div class="ui-dialog-emoji" id="uiDialogEmoji" aria-hidden="true">⚠️</div>
        <div class="ui-dialog-title" id="uiDialogTitle">Confirm</div>
        <div class="ui-dialog-body" id="uiDialogBody"></div>
        <input type="text" class="ui-dialog-input" id="uiDialogInput" style="display:none;" />
        <div class="ui-dialog-actions">
          <button type="button" class="celebration-modal-mute" id="uiDialogCancel">Cancel</button>
          <button type="button" class="celebration-modal-close" id="uiDialogOk">OK</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function openDialog(opts) {
    const options = opts || {};
    return new Promise((resolve) => {
      const backdrop = ensureHost();
      const title = document.getElementById('uiDialogTitle');
      const body = document.getElementById('uiDialogBody');
      const emoji = document.getElementById('uiDialogEmoji');
      const input = document.getElementById('uiDialogInput');
      const ok = document.getElementById('uiDialogOk');
      const cancel = document.getElementById('uiDialogCancel');
      title.textContent = options.title || 'Confirm';
      body.textContent = options.message || '';
      emoji.textContent = options.emoji || (options.mode === 'alert' ? 'ℹ️' : '⚠️');
      ok.textContent = options.okLabel || 'OK';
      cancel.textContent = options.cancelLabel || 'Cancel';
      cancel.style.display = options.mode === 'alert' ? 'none' : '';
      ok.classList.toggle('ui-dialog-danger', !!options.danger);
      if (options.mode === 'prompt') {
        input.style.display = '';
        input.value = options.defaultValue != null ? String(options.defaultValue) : '';
        input.placeholder = options.placeholder || '';
      } else {
        input.style.display = 'none';
        input.value = '';
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        backdrop.classList.remove('open');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onOk = () => {
        if (options.mode === 'prompt') finish(input.value);
        else if (options.mode === 'alert') finish(true);
        else finish(true);
      };
      const onCancel = () => finish(options.mode === 'prompt' ? null : false);
      const onBackdrop = (e) => {
        if (e.target === backdrop) onCancel();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && options.mode !== 'prompt') onOk();
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      backdrop.classList.add('open');
      requestAnimationFrame(() => {
        if (options.mode === 'prompt') input.focus();
        else ok.focus();
      });
    });
  }

  window.uiDialog = {
    alert(message, opts) {
      return openDialog(Object.assign({ mode: 'alert', title: 'Notice', emoji: 'ℹ️', message }, opts || {}));
    },
    confirm(message, opts) {
      return openDialog(Object.assign({ mode: 'confirm', title: 'Confirm', emoji: '⚠️', message }, opts || {}));
    },
    prompt(message, defaultValue, opts) {
      return openDialog(Object.assign({
        mode: 'prompt',
        title: 'Edit',
        emoji: '✏️',
        message,
        defaultValue: defaultValue || '',
      }, opts || {}));
    },
  };
})();
