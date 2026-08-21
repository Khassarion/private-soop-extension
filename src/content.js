/**
 * Content Script for Soop (play.sooplive.com)
 * Soop 페이지에서 실행되는 스크립트
 */

const cheerRunner = {
  isRunning: false,
  timer: null,
  endTime: 0,
  sentCount: 0,
  options: null,
  emoticonMenuOpened: false
};

const DEFAULT_CHEER_OPTIONS = {
  emoticon: '/응원봉2/',
  count: 4,
  minDelay: 1450,
  maxDelay: 2500,
  duration: 0
};

// 확장 프로그램에서 메시지 수신
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSoopInfo') {
    try {
      const info = extractSoopInfo();
      sendResponse({ success: true, data: info });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true; // 비동기 응답을 위해 true 반환
  }

  // 다른 액션 처리
  if (request.action === 'customAction') {
    // 커스텀 작업 구현
    sendResponse({ success: true, message: 'Custom action executed' });
    return true;
  }

  if (request.action === 'startCheer') {
    startCheer(request.options)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'stopCheer') {
    stopCheer();
    sendResponse({ success: true, data: getCheerStatus() });
    return true;
  }

  if (request.action === 'getCheerStatus') {
    sendResponse({ success: true, data: getCheerStatus() });
    return true;
  }
});

async function startCheer(options = {}) {
  if (cheerRunner.isRunning) {
    throw new Error('이미 응원봉 자동 전송이 실행 중입니다.');
  }

  const settings = { ...DEFAULT_CHEER_OPTIONS, ...options };
  validateCheerOptions(settings);
  await prepareCheerElements(settings.emoticon);

  cheerRunner.isRunning = true;
  cheerRunner.endTime = Date.now() + settings.duration * 1000;
  cheerRunner.sentCount = 0;
  cheerRunner.options = settings;
  runCheerLoop();

  return getCheerStatus();
}

function runCheerLoop() {
  if (!cheerRunner.isRunning) return;

  if (Date.now() >= cheerRunner.endTime) {
    stopCheer();
    return;
  }

  try {
    sendCheerSticks(cheerRunner.options.count);
  } catch (error) {
    stopCheer();
    console.error('응원봉 자동 전송 중지:', error);
    return;
  }

  const { minDelay, maxDelay } = cheerRunner.options;
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  cheerRunner.timer = setTimeout(runCheerLoop, delay);
}

function sendCheerSticks(count) {
  ensureCheerElements();

  const chatArea = document.querySelector('#write_area');
  const cheerButton = findEmoticonButton(cheerRunner.options.emoticon);
  const sendButton = document.querySelector('#btn_send');

  if (chatArea.innerText.trim() !== '') return;

  for (let index = 0; index < count; index += 1) {
    cheerButton.click();
  }
  sendButton.click();
  cheerRunner.sentCount += count;
}

function ensureCheerElements(emoticon = cheerRunner.options?.emoticon || DEFAULT_CHEER_OPTIONS.emoticon) {
  const chatArea = document.querySelector('#write_area');
  const cheerButton = findEmoticonButton(emoticon);
  const sendButton = document.querySelector('#btn_send');

  if (!chatArea || !cheerButton || !sendButton) {
    throw new Error('Soop 채팅창 또는 응원봉 버튼을 찾을 수 없습니다. 방송 페이지를 확인해주세요.');
  }
}

async function prepareCheerElements(emoticon) {
  if (!cheerRunner.emoticonMenuOpened) {
    if (findEmoticonButton(emoticon)) {
      cheerRunner.emoticonMenuOpened = true;
    } else {
      const emoticonMenuButton = document.querySelector('#btn_emo');
      if (!emoticonMenuButton) {
        throw new Error('이모티콘 메뉴 버튼(#btn_emo)을 찾을 수 없습니다. Soop 채팅창을 확인해주세요.');
      }
      emoticonMenuButton.click();
      cheerRunner.emoticonMenuOpened = true;
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      ensureCheerElements(emoticon);
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('이모티콘 버튼이 생성되지 않았습니다. 이모티콘 메뉴를 확인해주세요.');
}

function findEmoticonButton(emoticon) {
  return Array.from(document.querySelectorAll('img[title]'))
    .find((image) => image.title === emoticon);
}

function stopCheer() {
  if (cheerRunner.timer) {
    clearTimeout(cheerRunner.timer);
  }
  cheerRunner.isRunning = false;
  cheerRunner.timer = null;
  cheerRunner.endTime = 0;
  cheerRunner.options = null;
}

function getCheerStatus() {
  const remaining = cheerRunner.isRunning
    ? Math.max(0, Math.ceil((cheerRunner.endTime - Date.now()) / 1000))
    : 0;

  return {
    isRunning: cheerRunner.isRunning,
    remaining,
    sentCount: cheerRunner.sentCount
  };
}

function validateCheerOptions(options) {
  if (typeof options.emoticon !== 'string' || !/^\/.+\/$/.test(options.emoticon)) {
    throw new Error('이모티콘은 /이모티콘문자열/ 형식으로 입력해주세요.');
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) {
    throw new Error('응원봉 개수는 1에서 20 사이여야 합니다.');
  }
  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    throw new Error('자동 전송 시간이 올바르지 않습니다.');
  }
  if (!Number.isFinite(options.minDelay) || !Number.isFinite(options.maxDelay) ||
      options.minDelay < 1000 || options.maxDelay < options.minDelay) {
    throw new Error('전송 간격 설정이 올바르지 않습니다.');
  }
}

/**
 * Soop 페이지에서 정보 추출
 * @returns {Object} 추출된 정보
 */
function extractSoopInfo() {
  const info = {
    title: document.title || '',
    url: window.location.href,
    timestamp: Date.now(),
    // 여기에 Soop 페이지의 특정 요소를 추출하는 로직 추가
    // 예: 재생 중인 곡 정보, 재생 시간 등
  };

  // 페이지의 특정 요소 찾기 (예시)
  // 실제 Soop 페이지 구조에 맞게 수정 필요
  try {
    // 예시: 특정 클래스나 ID를 가진 요소 찾기
    // const playerElement = document.querySelector('.player');
    // if (playerElement) {
    //   info.playerInfo = playerElement.textContent;
    // }
  } catch (error) {
    console.error('Soop 정보 추출 오류:', error);
  }

  return info;
}

// 페이지 로드 완료 시 초기화
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSoop);
} else {
  initializeSoop();
}

function initializeSoop() {
  console.log('Soop Content Script 초기화됨');
  initializeControlPanel();
}

function initializeControlPanel() {
  if (document.getElementById('private-extension-panel-host')) return;

  const host = document.createElement('div');
  host.id = 'private-extension-panel-host';
  host.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 2147483647;';
  document.documentElement.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel { width: 360px; max-height: calc(100vh - 40px); overflow-y: auto; padding: 18px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.22); font: 14px/1.4 Arial, sans-serif; }
      .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; cursor: move; user-select: none; }
      h1 { margin: 0; font-size: 18px; color: #374151; }
      .collapse-button { width: 28px; height: 28px; padding: 0; font-size: 18px; line-height: 1; }
      .panel.collapsed { width: 44px; height: 44px; min-height: 44px; padding: 7px; overflow: hidden; }
      .panel.collapsed .panel-header { margin: 0; }
      .panel.collapsed .panel-header h1 { display: none; }
      .panel.collapsed .collapse-button { width: 30px; height: 30px; }
      .panel.collapsed > :not(.panel-header) { display: none; }
      h2 { margin: 16px 0 8px; font-size: 14px; color: #4b5563; }
      .row { display: flex; gap: 7px; margin: 7px 0; align-items: center; }
      .row label { flex: 1; color: #4b5563; font-size: 13px; }
      input { min-width: 0; flex: 1; padding: 8px; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
      input[type="number"] { flex: 0 0 82px; }
      button { padding: 8px 10px; border: 0; border-radius: 5px; color: #fff; background: #2563eb; cursor: pointer; font: inherit; }
      button:hover:not(:disabled) { background: #1d4ed8; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .secondary { background: #64748b; }
      .danger { background: #dc2626; }
      .full { width: 100%; margin-top: 8px; }
      .result, .status, .info { margin-top: 10px; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; }
      .result { display: none; }
      .result img { width: 78px; height: 58px; object-fit: cover; float: left; margin-right: 9px; border-radius: 4px; }
      .result p { margin: 3px 0; font-size: 12px; }
      .status { display: none; }
      .status-bar { height: 8px; margin: 8px 0; overflow: hidden; background: #e2e8f0; border-radius: 4px; }
      .progress { width: 0; height: 100%; background: #2563eb; transition: width .2s linear; }
      .status-line { display: flex; justify-content: space-between; font-size: 12px; color: #64748b; }
      .message { min-height: 20px; margin-top: 10px; color: #2563eb; font-size: 12px; }
      .message.error { color: #dc2626; }
      .info { display: none; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    </style>
    <div class="panel collapsed">
      <div class="panel-header"><h1>노래 응원봉 자동 전송</h1><button id="collapse" class="collapse-button" title="패널 펼치기">+</button></div>
      <h2>노래 검색</h2>
      <div class="row"><input id="song-query" placeholder="노래 제목 또는 아티스트" /><button id="search">검색</button></div>
      <div class="row"><input id="api-key" type="password" placeholder="YouTube API Key" /><button id="save-key" class="secondary">저장</button></div>
      <div id="song-result" class="result"><img id="thumbnail" alt=""><strong id="song-title"></strong><p id="song-channel"></p><p id="song-duration"></p></div>
      <h2>전송 설정</h2>
      <div class="row"><label for="emoticon">이모티콘 문자열</label><input id="emoticon" value="/응원봉2/" placeholder="/응원봉2/"></div>
      <div class="row"><label for="count">한 번에 보낼 개수</label><input id="count" type="number" min="1" max="20" value="4"></div>
      <div class="row"><label for="min-delay">최소 간격 (초)</label><input id="min-delay" type="number" min="1" step="0.1" value="1.5"></div>
      <div class="row"><label for="max-delay">최대 간격 (초)</label><input id="max-delay" type="number" min="1" step="0.1" value="2.5"></div>
      <button id="start" class="full" disabled>작업 시작</button>
      <div id="status" class="status"><div>자동 전송 중 <span id="remaining"></span></div><div class="status-bar"><div id="progress" class="progress"></div></div><div class="status-line"><span id="elapsed">0:00</span><span id="sent">0개 전송</span></div><button id="stop" class="full danger">중지</button></div>
      <div class="row"><button id="check" class="secondary">Soop 페이지 확인</button><button id="info-button" class="secondary">정보 가져오기</button></div>
      <div id="info" class="info"></div>
      <div id="message" class="message"></div>
    </div>`;

  const panel = (selector) => shadowRoot.querySelector(selector);
  const apiKeyInput = panel('#api-key');
  const songQueryInput = panel('#song-query');
  const searchButton = panel('#search');
  const startButton = panel('#start');
  const status = panel('#status');
  let songInfo = null;
  let statusTimer = null;
  let fadeTimer = null;
  let isDragging = false;
  let dragStartedOnCollapseButton = false;
  let dragMoved = false;
  let suppressCollapseClick = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const panelElement = panel('.panel');
  const panelHeader = panel('.panel-header');
  const collapseButton = panel('#collapse');

  collapseButton.addEventListener('click', () => {
    if (suppressCollapseClick) {
      suppressCollapseClick = false;
      return;
    }
    panelElement.classList.toggle('collapsed');
    const isCollapsed = panelElement.classList.contains('collapsed');
    collapseButton.textContent = isCollapsed ? '+' : '−';
    collapseButton.title = isCollapsed ? '패널 펼치기' : '패널 접기';
    if (!isCollapsed) {
      if (fadeTimer) clearTimeout(fadeTimer);
      host.style.opacity = '1';
    } else {
      resetFadeTimer();
    }
  });

  panelHeader.addEventListener('mousedown', (event) => {
    const bounds = host.getBoundingClientRect();
    dragOffsetX = event.clientX - bounds.left;
    dragOffsetY = event.clientY - bounds.top;
    dragStartedOnCollapseButton = event.target === collapseButton;
    dragMoved = false;
    host.style.left = `${bounds.left}px`;
    host.style.top = `${bounds.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    isDragging = true;
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    host.style.opacity = '1';
    resetFadeTimer();

    if (!isDragging) return;
    if (Math.abs(event.clientX - (dragOffsetX + host.getBoundingClientRect().left)) > 3 ||
        Math.abs(event.clientY - (dragOffsetY + host.getBoundingClientRect().top)) > 3) {
      dragMoved = true;
    }
    const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - host.offsetHeight);
    const left = Math.min(maxLeft, Math.max(0, event.clientX - dragOffsetX));
    const top = Math.min(maxTop, Math.max(0, event.clientY - dragOffsetY));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  });

  document.addEventListener('mouseup', () => {
    if (dragStartedOnCollapseButton && dragMoved) suppressCollapseClick = true;
    isDragging = false;
    dragStartedOnCollapseButton = false;
  });
  resetFadeTimer();

  function resetFadeTimer() {
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
       if (!isDragging && panelElement.classList.contains('collapsed')) host.style.opacity = '0';
    }, 1000);
  }

  chrome.storage.local.get(['youtubeApiKey', 'cheerEmoticon']).then((data) => {
    if (data.youtubeApiKey) apiKeyInput.value = data.youtubeApiKey;
    if (data.cheerEmoticon) panel('#emoticon').value = data.cheerEmoticon;
  });

  panel('#emoticon').addEventListener('change', (event) => {
    chrome.storage.local.set({ cheerEmoticon: event.target.value.trim() });
  });

  panel('#save-key').addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) return showPanelMessage('API Key를 입력해주세요.', true);
    await chrome.storage.local.set({ youtubeApiKey: apiKey });
    showPanelMessage('API Key가 저장되었습니다.');
  });

  searchButton.addEventListener('click', async () => {
    const query = songQueryInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!query || !apiKey) return showPanelMessage('검색어와 API Key를 입력해주세요.', true);
    searchButton.disabled = true;
    try {
      const result = await new SongSearch(apiKey).searchSong(query);
      songInfo = result;
      panel('#song-title').textContent = result.title;
      panel('#song-channel').textContent = result.channelTitle;
      panel('#song-duration').textContent = `길이: ${new SongSearch(apiKey).formatDuration(result.durationInSeconds)}`;
      panel('#thumbnail').src = result.thumbnail;
      panel('#song-result').style.display = 'block';
      startButton.disabled = false;
      showPanelMessage('노래를 찾았습니다.');
    } catch (error) {
      showPanelMessage(`검색 실패: ${error.message}`, true);
    } finally {
      searchButton.disabled = false;
    }
  });

  startButton.addEventListener('click', async () => {
    if (!songInfo) return showPanelMessage('먼저 노래를 검색해주세요.', true);
    const options = {
      emoticon: panel('#emoticon').value.trim(),
      count: Number(panel('#count').value),
      minDelay: Number(panel('#min-delay').value) * 1000,
      maxDelay: Number(panel('#max-delay').value) * 1000,
      duration: songInfo.durationInSeconds
    };
    try {
      await chrome.storage.local.set({ cheerEmoticon: options.emoticon });
      const result = await startCheer(options);
      startButton.disabled = true;
      status.style.display = 'block';
      beginStatusTimer();
      updatePanelStatus(result);
      showPanelMessage('작업이 시작되었습니다.');
    } catch (error) {
      showPanelMessage(`작업 시작 실패: ${error.message}`, true);
    }
  });

  panel('#stop').addEventListener('click', () => {
    stopCheer();
    stopStatusTimer();
    resetPanelStatus();
    showPanelMessage('작업을 중지했습니다.');
  });

  panel('#check').addEventListener('click', () => {
    showPanelMessage('현재 play.sooplive.com 페이지입니다.');
  });

  panel('#info-button').addEventListener('click', () => {
    const info = extractSoopInfo();
    const infoElement = panel('#info');
    infoElement.textContent = JSON.stringify(info, null, 2);
    infoElement.style.display = 'block';
  });

  function beginStatusTimer() {
    stopStatusTimer();
    statusTimer = setInterval(() => {
      const currentStatus = getCheerStatus();
      updatePanelStatus(currentStatus);
      if (!currentStatus.isRunning) {
        stopStatusTimer();
        resetPanelStatus();
        showPanelMessage('작업이 완료되었습니다.');
      }
    }, 500);
  }

  function stopStatusTimer() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  function updatePanelStatus(currentStatus) {
    const duration = songInfo?.durationInSeconds || 1;
    const elapsed = Math.max(0, duration - currentStatus.remaining);
    panel('#remaining').textContent = `${formatPanelTime(currentStatus.remaining)} 남음`;
    panel('#elapsed').textContent = formatPanelTime(elapsed);
    panel('#sent').textContent = `${currentStatus.sentCount}개 전송`;
    panel('#progress').style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
  }

  function resetPanelStatus() {
    status.style.display = 'none';
    startButton.disabled = !songInfo;
  }

  function formatPanelTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function showPanelMessage(text, isError = false) {
    const message = panel('#message');
    message.textContent = text;
    message.className = `message${isError ? ' error' : ''}`;
  }
}
