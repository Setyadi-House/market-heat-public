(function () {
  'use strict';
  const openers = new WeakMap();

  document.querySelectorAll('[data-help]').forEach(button => {
    const dialog = document.getElementById(button.dataset.help);
    if (!(dialog instanceof HTMLDialogElement)) return;

    button.addEventListener('click', () => {
      openers.set(dialog, button);
      dialog.showModal();
      dialog.scrollTop = 0;
    });
    dialog.addEventListener('close', () => {
      const opener = openers.get(dialog);
      if (opener && opener.isConnected) opener.focus({preventScroll: true});
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) {
        dialog.close();
      }
    });
  });
})();
