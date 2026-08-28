(() => {
  const hideBroadcastButton = () => {
    const broadcastButton = document.querySelector('button.btn-broadcast');
    if (broadcastButton) broadcastButton.style.display = 'none';
  };

  hideBroadcastButton();

  const observer = new MutationObserver(hideBroadcastButton);
  observer.observe(document.body, { childList: true, subtree: true });
})();
