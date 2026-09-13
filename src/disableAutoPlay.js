(() => {
  const autoPlayButtonSelector = '#player > div.message_player_wrap > div > button';
  const clickedButtons = new WeakSet();

  const disableAutoPlay = () => {
    const autoPlayButton = document.querySelector(autoPlayButtonSelector);
    if (!autoPlayButton || clickedButtons.has(autoPlayButton)) return;

    clickedButtons.add(autoPlayButton);
    console.log('Disabling auto-play...');
    autoPlayButton.click();
  };

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.disableAutoPlay?.enabled === false) return;

    disableAutoPlay();
    const observer = new MutationObserver(disableAutoPlay);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();