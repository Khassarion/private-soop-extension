(() => {
  const hideBroadcastButton = () => document
    .querySelector('button.btn-broadcast')?.style.setProperty('display', 'none');

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.hideBroadcastButton?.enabled === false) return;

    hideBroadcastButton();
    const observer = new MutationObserver(hideBroadcastButton);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
