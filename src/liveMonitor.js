/**
 * Content Script for Soop live tabs auto-opened by the "라이브 자동 열기" 기능
 * 백그라운드가 생성한 감시 대상 탭에서만 동작한다 (사용자가 직접 연 탭에는 아무 영향 없음).
 */

(() => {
  const LOG_TAG = '[LiveMonitor]';
  const STALL_CHECK_INTERVAL_MS = 3000;
  const STALL_THRESHOLD_MS = 12000;
  const MAX_RELOAD_ATTEMPTS = 3;
  const RELOAD_COUNT_KEY = 'pextLiveMonitorReloadCount';
  const DEFAULT_AUTO_CLOSE_DELAY_SECONDS = 5;

  const PLAYBACK_START_POLL_MS = 500;
  const PLAYBACK_START_TIMEOUT_MS = 15000;

  let attachedVideo = null;
  let lastCurrentTime = -1;
  let lastProgressAt = Date.now();
  let stallCheckTimer = null;
  let mutationObserver = null;
  let checkInFlight = false;
  let handledEnd = false;
  let playbackConfirmed = false;

  init();

  async function init() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'liveMonitor:init' });
    } catch (error) {
      return; // 확장 컨텍스트가 아직 준비되지 않음
    }
    if (!response?.monitored) return;

    const autoCloseDelaySeconds = response.autoCloseDelaySeconds ?? DEFAULT_AUTO_CLOSE_DELAY_SECONDS;
    console.log(`${LOG_TAG} ${response.streamerId} - 감시 탭으로 확인됨, 재생 감시 시작`);
    startPlaybackWatch(response.streamerId, autoCloseDelaySeconds);
  }

  function startPlaybackWatch(streamerId, autoCloseDelaySeconds) {
    tryAttachVideo(streamerId, autoCloseDelaySeconds);

    mutationObserver = new MutationObserver(() => {
      tryAttachVideo(streamerId, autoCloseDelaySeconds);
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

    stallCheckTimer = setInterval(() => {
      checkStall(streamerId, autoCloseDelaySeconds);
    }, STALL_CHECK_INTERVAL_MS);
  }

  function tryAttachVideo(streamerId, autoCloseDelaySeconds) {
    const video = document.querySelector('video');
    if (!video || video === attachedVideo) return;

    attachedVideo = video;
    lastCurrentTime = video.currentTime;
    lastProgressAt = Date.now();

    video.addEventListener('ended', () => handlePlaybackStopped(streamerId, autoCloseDelaySeconds));
    video.addEventListener('error', () => handlePlaybackStopped(streamerId, autoCloseDelaySeconds));

    watchForPlaybackStart(video);
  }

  /**
   * 재생이 실제로 시작되는(currentTime이 처음 증가하는) 시점을 빠르게 감지해서
   * background에 알린다. background는 이 신호를 받으면 임시로 주었던 탭 포커스를
   * 원래 탭으로 되돌린다. (Soop 플레이어가 탭이 활성화되어야 스트리밍을 시작하는 것으로 보임)
   */
  function watchForPlaybackStart(video) {
    if (playbackConfirmed) return;
    const baseline = video.currentTime;
    const startedAt = Date.now();

    const check = () => {
      if (playbackConfirmed || video !== attachedVideo) return;
      if (video.currentTime > baseline) {
        playbackConfirmed = true;
        console.log(`${LOG_TAG} 영상 재생 시작 확인됨`);
        chrome.runtime.sendMessage({ action: 'liveMonitor:playbackStarted' }).catch(() => {});
        return;
      }
      if (Date.now() - startedAt >= PLAYBACK_START_TIMEOUT_MS) return;
      setTimeout(check, PLAYBACK_START_POLL_MS);
    };

    setTimeout(check, PLAYBACK_START_POLL_MS);
  }

  function checkStall(streamerId, autoCloseDelaySeconds) {
    if (handledEnd || !attachedVideo) return;

    const currentTime = attachedVideo.currentTime;
    const now = Date.now();

    if (currentTime !== lastCurrentTime) {
      lastCurrentTime = currentTime;
      lastProgressAt = now;
      return;
    }

    if (now - lastProgressAt >= STALL_THRESHOLD_MS) {
      console.log(`${LOG_TAG} ${streamerId} - 재생 정체 감지 (${STALL_THRESHOLD_MS}ms 동안 진행 없음)`);
      handlePlaybackStopped(streamerId, autoCloseDelaySeconds);
    }
  }

  async function handlePlaybackStopped(streamerId, autoCloseDelaySeconds) {
    if (handledEnd || checkInFlight) return;
    checkInFlight = true;

    console.log(`${LOG_TAG} ${streamerId} - 재생 중단 감지, 라이브 상태 재확인 요청`);

    let live = false;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'liveMonitor:checkStillLive',
        streamerId,
      });
      live = Boolean(response?.live);
    } catch (error) {
      checkInFlight = false;
      console.log(`${LOG_TAG} ${streamerId} - 라이브 상태 재확인 실패, 다음 주기에 재시도`);
      return; // 확인 실패 시 다음 주기에 재시도
    }

    console.log(`${LOG_TAG} ${streamerId} - 재확인 결과: ${live ? '방송 중 (새로고침 시도)' : '방송 종료 (자동 닫기 진행)'}`);

    if (live) {
      checkInFlight = false;
      attemptReload(streamerId);
      return;
    }

    handledEnd = true;
    stopWatching();
    showAutoCloseModal(autoCloseDelaySeconds);
  }

  function attemptReload(streamerId) {
    const count = Number(sessionStorage.getItem(RELOAD_COUNT_KEY) || '0');
    if (count >= MAX_RELOAD_ATTEMPTS) {
      // 라이브 API는 계속 방송 중이라고 하는데 재생이 반복적으로 끊기는 경우.
      // 원인을 알 수 없으므로 더 이상 자동 조치하지 않고 감시만 멈춘다.
      console.log(`${LOG_TAG} ${streamerId} - 재로딩 상한(${MAX_RELOAD_ATTEMPTS}회) 도달, 감시 중단`);
      stopWatching();
      return;
    }
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
    console.log(`${LOG_TAG} ${streamerId} - 페이지 새로고침 시도 (${count + 1}/${MAX_RELOAD_ATTEMPTS})`);
    location.reload();
  }

  function stopWatching() {
    if (stallCheckTimer) clearInterval(stallCheckTimer);
    if (mutationObserver) mutationObserver.disconnect();
    stallCheckTimer = null;
    mutationObserver = null;
  }

  function showAutoCloseModal(autoCloseDelaySeconds) {
    if (document.getElementById('private-extension-endcast-modal-host')) return;
    console.log(`${LOG_TAG} 방송 종료 확인 - ${autoCloseDelaySeconds}초 후 탭 자동 닫기 카운트다운 표시`);

    const host = document.createElement('div');
    host.id = 'private-extension-endcast-modal-host';
    host.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 2147483647;';
    document.documentElement.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .modal { width: 300px; padding: 18px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); font: 14px/1.5 Arial, sans-serif; }
        h1 { margin: 0 0 8px; font-size: 15px; color: #374151; }
        p { margin: 0 0 14px; color: #4b5563; font-size: 13px; }
        strong { color: #dc2626; }
        button { width: 100%; padding: 9px; border: 0; border-radius: 6px; color: #fff; background: #64748b; cursor: pointer; font: inherit; }
        button:hover { background: #475569; }
      </style>
      <div class="modal">
        <h1>방송이 종료되었습니다</h1>
        <p><strong id="remaining"></strong>초 후 이 탭이 자동으로 닫힙니다.</p>
        <button id="cancel">닫지 않기</button>
      </div>`;

    const remainingEl = shadowRoot.getElementById('remaining');
    const cancelButton = shadowRoot.getElementById('cancel');

    let remaining = autoCloseDelaySeconds;
    remainingEl.textContent = String(remaining);

    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        console.log(`${LOG_TAG} 카운트다운 종료 - 탭 닫기 요청`);
        chrome.runtime.sendMessage({ action: 'liveMonitor:closeTab' }).catch(() => {});
        return;
      }
      remainingEl.textContent = String(remaining);
    }, 1000);

    cancelButton.addEventListener('click', () => {
      clearInterval(timer);
      host.remove();
      console.log(`${LOG_TAG} 사용자가 "닫지 않기" 클릭 - 자동 닫기 취소`);
    });
  }
})();
