(() => {
  const hideBroadcastButton = () => document
    .querySelector('button.btn-broadcast')?.style.setProperty('display', 'none');

  hideBroadcastButton();

  const observer = new MutationObserver(hideBroadcastButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
