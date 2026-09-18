/**
 * 설정 페이지 로직
 */

const DEFAULT_SETTINGS = {
  features: {
    cheerAutoSend: {
      enabled: true,
      youtubeApiKey: '',
      emoticon: '/응원봉2/',
      count: 4,
      minDelay: 1500,
      maxDelay: 2500,
    },
    disableAutoPlay: {
      enabled: true,
    },
    hideBroadcastButton: {
      enabled: true,
    },
    autoLiveOpen: {
      enabled: false,
      streamers: [],
      pollIntervalMinutes: 1,
      autoCloseDelaySeconds: 5,
    },
    pointStatus: {
      enabled: true,
    },
    vodFileInfo: {
      enabled: true,
    },
  },
};

let settings = null;

const el = {
  cheerAutoSendEnabled: document.getElementById('cheerAutoSendEnabled'),
  cheerAutoSendBody: document.getElementById('cheerAutoSendBody'),
  youtubeApiKey: document.getElementById('youtubeApiKey'),
  cheerEmoticon: document.getElementById('cheerEmoticon'),
  cheerCount: document.getElementById('cheerCount'),
  cheerMinDelay: document.getElementById('cheerMinDelay'),
  cheerMaxDelay: document.getElementById('cheerMaxDelay'),

  disableAutoPlayEnabled: document.getElementById('disableAutoPlayEnabled'),
  hideBroadcastButtonEnabled: document.getElementById('hideBroadcastButtonEnabled'),

  autoLiveOpenEnabled: document.getElementById('autoLiveOpenEnabled'),
  autoLiveOpenBody: document.getElementById('autoLiveOpenBody'),
  pollIntervalMinutes: document.getElementById('pollIntervalMinutes'),
  autoCloseDelaySeconds: document.getElementById('autoCloseDelaySeconds'),
  newStreamerId: document.getElementById('newStreamerId'),
  addStreamerBtn: document.getElementById('addStreamerBtn'),
  streamerList: document.getElementById('streamerList'),
  streamerEmptyHint: document.getElementById('streamerEmptyHint'),

  pointStatusEnabled: document.getElementById('pointStatusEnabled'),

  vodFileInfoEnabled: document.getElementById('vodFileInfoEnabled'),

  toast: document.getElementById('toast'),
};

document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();
  renderAll();
  setupEventListeners();
});

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get(['settings']);
  const merged = { features: {} };
  for (const [key, defaults] of Object.entries(DEFAULT_SETTINGS.features)) {
    merged.features[key] = { ...defaults, ...(saved?.features?.[key] || {}) };
  }
  return merged;
}

async function persistSettings() {
  await chrome.storage.local.set({ settings });
  showToast('저장되었습니다.');
}

function renderAll() {
  const cheer = settings.features.cheerAutoSend;
  el.cheerAutoSendEnabled.checked = cheer.enabled;
  el.youtubeApiKey.value = cheer.youtubeApiKey || '';
  el.cheerEmoticon.value = cheer.emoticon;
  el.cheerCount.value = cheer.count;
  el.cheerMinDelay.value = cheer.minDelay / 1000;
  el.cheerMaxDelay.value = cheer.maxDelay / 1000;
  updateCardBodyState(el.cheerAutoSendBody, cheer.enabled);

  el.disableAutoPlayEnabled.checked = settings.features.disableAutoPlay.enabled;
  el.hideBroadcastButtonEnabled.checked = settings.features.hideBroadcastButton.enabled;

  const autoLiveOpen = settings.features.autoLiveOpen;
  el.autoLiveOpenEnabled.checked = autoLiveOpen.enabled;
  el.pollIntervalMinutes.value = autoLiveOpen.pollIntervalMinutes;
  el.autoCloseDelaySeconds.value = autoLiveOpen.autoCloseDelaySeconds;
  updateCardBodyState(el.autoLiveOpenBody, autoLiveOpen.enabled);
  renderStreamerList();

  el.pointStatusEnabled.checked = settings.features.pointStatus.enabled;

  el.vodFileInfoEnabled.checked = settings.features.vodFileInfo.enabled;
}

function updateCardBodyState(bodyEl, enabled) {
  bodyEl.classList.toggle('disabled', !enabled);
}

function renderStreamerList() {
  const streamers = settings.features.autoLiveOpen.streamers;
  el.streamerList.innerHTML = '';
  el.streamerEmptyHint.style.display = streamers.length === 0 ? 'block' : 'none';

  streamers.forEach((streamer, index) => {
    const item = document.createElement('li');
    item.className = `streamer-item${streamer.enabled === false ? ' streamer-disabled' : ''}`;
    item.innerHTML = `
      <label class="switch switch-sm">
        <input type="checkbox" class="streamer-toggle" ${streamer.enabled !== false ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <span class="streamer-id"></span>
      <button class="btn-danger streamer-remove">삭제</button>
    `;
    item.querySelector('.streamer-id').textContent = streamer.id;

    item.querySelector('.streamer-toggle').addEventListener('change', (event) => {
      streamers[index].enabled = event.target.checked;
      persistSettings();
      renderStreamerList();
    });

    item.querySelector('.streamer-remove').addEventListener('click', () => {
      streamers.splice(index, 1);
      persistSettings();
      renderStreamerList();
    });

    el.streamerList.appendChild(item);
  });
}

function setupEventListeners() {
  el.cheerAutoSendEnabled.addEventListener('change', (e) => {
    settings.features.cheerAutoSend.enabled = e.target.checked;
    updateCardBodyState(el.cheerAutoSendBody, e.target.checked);
    persistSettings();
  });

  el.youtubeApiKey.addEventListener('change', (e) => {
    settings.features.cheerAutoSend.youtubeApiKey = e.target.value.trim();
    persistSettings();
  });

  el.cheerEmoticon.addEventListener('change', (e) => {
    const value = e.target.value.trim();
    if (!/^\/.+\/$/.test(value)) {
      showToast('이모티콘은 /이모티콘문자열/ 형식으로 입력해주세요.', true);
      e.target.value = settings.features.cheerAutoSend.emoticon;
      return;
    }
    settings.features.cheerAutoSend.emoticon = value;
    persistSettings();
  });

  el.cheerCount.addEventListener('change', (e) => {
    const count = clampInt(e.target.value, 1, 20, settings.features.cheerAutoSend.count);
    e.target.value = count;
    settings.features.cheerAutoSend.count = count;
    persistSettings();
  });

  el.cheerMinDelay.addEventListener('change', (e) => {
    const seconds = clampFloat(e.target.value, 1, Infinity, settings.features.cheerAutoSend.minDelay / 1000);
    e.target.value = seconds;
    settings.features.cheerAutoSend.minDelay = Math.round(seconds * 1000);
    persistSettings();
  });

  el.cheerMaxDelay.addEventListener('change', (e) => {
    const minSeconds = settings.features.cheerAutoSend.minDelay / 1000;
    const seconds = clampFloat(e.target.value, minSeconds, Infinity, settings.features.cheerAutoSend.maxDelay / 1000);
    e.target.value = seconds;
    settings.features.cheerAutoSend.maxDelay = Math.round(seconds * 1000);
    persistSettings();
  });

  el.disableAutoPlayEnabled.addEventListener('change', (e) => {
    settings.features.disableAutoPlay.enabled = e.target.checked;
    persistSettings();
  });

  el.hideBroadcastButtonEnabled.addEventListener('change', (e) => {
    settings.features.hideBroadcastButton.enabled = e.target.checked;
    persistSettings();
  });

  el.autoLiveOpenEnabled.addEventListener('change', (e) => {
    settings.features.autoLiveOpen.enabled = e.target.checked;
    updateCardBodyState(el.autoLiveOpenBody, e.target.checked);
    persistSettings();
  });

  el.pollIntervalMinutes.addEventListener('change', (e) => {
    const minutes = clampInt(e.target.value, 1, 1440, settings.features.autoLiveOpen.pollIntervalMinutes);
    e.target.value = minutes;
    settings.features.autoLiveOpen.pollIntervalMinutes = minutes;
    persistSettings();
  });

  el.autoCloseDelaySeconds.addEventListener('change', (e) => {
    const seconds = clampInt(e.target.value, 1, 300, settings.features.autoLiveOpen.autoCloseDelaySeconds);
    e.target.value = seconds;
    settings.features.autoLiveOpen.autoCloseDelaySeconds = seconds;
    persistSettings();
  });

  el.addStreamerBtn.addEventListener('click', handleAddStreamer);
  el.newStreamerId.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddStreamer();
  });

  el.pointStatusEnabled.addEventListener('change', (e) => {
    settings.features.pointStatus.enabled = e.target.checked;
    persistSettings();
  });

  el.vodFileInfoEnabled.addEventListener('change', (e) => {
    settings.features.vodFileInfo.enabled = e.target.checked;
    persistSettings();
  });
}

function handleAddStreamer() {
  const id = el.newStreamerId.value.trim();
  if (!id) {
    showToast('스트리머 ID를 입력해주세요.', true);
    return;
  }

  const streamers = settings.features.autoLiveOpen.streamers;
  if (streamers.some((s) => s.id === id)) {
    showToast('이미 등록된 스트리머입니다.', true);
    return;
  }

  streamers.push({ id, enabled: true });
  el.newStreamerId.value = '';
  persistSettings();
  renderStreamerList();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

let toastTimer = null;
function showToast(text, isError = false) {
  el.toast.textContent = text;
  el.toast.style.background = isError ? '#dc2626' : '#1f2937';
  el.toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('visible');
  }, 2000);
}
