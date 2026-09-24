/**
 * Background Service Worker
 * 확장 프로그램의 백그라운드 작업을 처리합니다.
 */

import { isStreamerLive, getLoginId, getMissionStatus, getSoopVodInfo } from './soopLiveApi.js';

const LOG_TAG = '[LiveMonitor]';
const LIVE_CHECK_ALARM_NAME = 'liveCheck';
const MIN_POLL_INTERVAL_MINUTES = 1;
const FOCUS_RESTORE_FALLBACK_MS = 10000;

// Soop 페이지가 탭이 실제로 포커스(활성)되기 전에는 스트리밍을 시작하지 않는 것으로 보여,
// 새 탭을 잠깐 활성화했다가 재생이 시작되면(or 타임아웃 시) 원래 보고 있던 탭으로 되돌린다.
// 서비스 워커가 중간에 재시작되면 이 메모리 맵은 사라질 수 있는데, 그 경우 새 탭이 포커스된
// 채로 남는 정도의 낮은 리스크만 있어 in-memory Map으로 충분하다.
const pendingFocusRestore = new Map(); // newTabId -> previousActiveTabId | null

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
      streamers: [], // { id: string, enabled: boolean }
      pollIntervalMinutes: 1,
      autoCloseDelaySeconds: 5,
    },
    pointStatus: {
      enabled: true,
    },
    vodFileInfo: {
      enabled: true,
      // YouTube Studio 업로드 창 자동 입력 옵션 (youtubeStudio.js가 사용)
      youtubeVisibility: 'unlisted', // 'private' | 'unlisted' | 'public'
      youtubeNotForKids: true,
      youtubePlaylists: [], // Studio에 보이는 재생목록 이름 (정확히 일치해야 함)
      downloadSubfolder: '', // Chrome 다운로드 폴더 기준 하위 폴더 (비우면 바로 저장)
    },
  },
};

function todayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 저장된 설정과 기본값을 얕은 병합(기능 단위)하여 반환합니다.
 * 새로 추가된 기능/필드가 저장소에 없어도 기본값으로 채워집니다.
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
async function getSettings() {
  const { settings } = await chrome.storage.local.get(['settings']);
  const merged = {
    features: {},
  };
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS.features)) {
    merged.features[key] = { ...defaultValue, ...(settings?.features?.[key] || {}) };
  }
  return merged;
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

/**
 * 확장 프로그램 설치 시 기존 flat 키(youtubeApiKey, cheerEmoticon)를
 * settings.features.cheerAutoSend 구조로 1회 마이그레이션합니다.
 */
async function migrateLegacySettingsIfNeeded() {
  const { settings, youtubeApiKey, cheerEmoticon } = await chrome.storage.local.get([
    'settings',
    'youtubeApiKey',
    'cheerEmoticon',
  ]);

  if (settings) return; // 이미 마이그레이션됨

  const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (youtubeApiKey) merged.features.cheerAutoSend.youtubeApiKey = youtubeApiKey;
  if (cheerEmoticon) merged.features.cheerAutoSend.emoticon = cheerEmoticon;

  await saveSettings(merged);
}

async function getMonitoredTabs() {
  const { monitoredTabs } = await chrome.storage.session.get(['monitoredTabs']);
  return monitoredTabs || {};
}

async function setMonitoredTabs(monitoredTabs) {
  await chrome.storage.session.set({ monitoredTabs });
}

// YouTube Studio 업로드 창을 열면서 미리 채워줄 제목/설명을 탭별로 보관한다.
// (여러 파일의 업로드 탭을 연달아 열어도 서로 섞이지 않도록 tabId로 구분)
const STUDIO_LOG_TAG = '[YoutubeStudio]';
const YOUTUBE_UPLOAD_PAGE_URL = 'https://www.youtube.com/upload';

async function getPendingStudioUploads() {
  const { pendingStudioUploads } = await chrome.storage.session.get(['pendingStudioUploads']);
  return pendingStudioUploads || {};
}

async function setPendingStudioUploads(pendingStudioUploads) {
  await chrome.storage.session.set({ pendingStudioUploads });
}

/** Studio 탭의 content script에 전달할 데이터(제목/설명/파일 후보/저장된 옵션)를 만든다. */
async function buildStudioPayload(entry) {
  const { vodFileInfo } = (await getSettings()).features;
  return {
    title: entry.title,
    description: entry.description,
    fileNames: entry.fileNames || [],
    downloadSubfolder: normalizeSubfolder(vodFileInfo.downloadSubfolder),
    options: {
      visibility: vodFileInfo.youtubeVisibility,
      notForKids: vodFileInfo.youtubeNotForKids,
      playlists: vodFileInfo.youtubePlaylists,
    },
  };
}

/** 탭의 content script에 메시지를 보내되, 응답이 없거나 실패하면 null (멈춰버리지 않도록 타임아웃) */
function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    chrome.tabs
      .sendMessage(tabId, message)
      .then((response) => {
        clearTimeout(timer);
        resolve(response ?? null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

/**
 * 우리가 열었던 Studio 탭 중 지금 업로드 창이 비어 있는(저장까지 끝난) 탭을 찾아, 그 탭에서
 * 새 업로드를 시작시킨다. 성공하면 그 탭의 id를, 재사용할 탭이 없거나 실패하면 null을 반환한다
 * (호출부가 새 탭을 여는 것으로 넘어간다). 진행 중이거나 저장 전인 업로드 창이 열린 탭은
 * content script가 재사용 불가로 답하므로 절대 건드리지 않는다.
 */
async function tryReuseStudioTab(entry) {
  const pending = await getPendingStudioUploads();
  const payload = await buildStudioPayload(entry);
  let pendingChanged = false;

  for (const idText of Object.keys(pending)) {
    const tabId = Number(idText);

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      delete pending[idText]; // 이미 닫힌 탭
      pendingChanged = true;
      continue;
    }

    const probe = await sendToTab(tabId, { action: 'youtubeStudio:probe' }, 2000);
    if (!probe?.reusable) continue;

    const result = await sendToTab(tabId, { action: 'youtubeStudio:restart', payload }, 25000);
    if (!result?.started) {
      console.log(`${STUDIO_LOG_TAG} 탭 재사용 실패 (tabId=${tabId}): ${result?.reason || '응답 없음'}`);
      continue;
    }

    pending[idText] = entry; // 탭이 새로고침돼도 최신 업로드 데이터로 이어지게 갱신
    await setPendingStudioUploads(pending);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabId;
  }

  if (pendingChanged) await setPendingStudioUploads(pending);
  return null;
}

/**
 * 다운로드 하위 폴더 설정을 안전한 상대 경로로 정리한다 ("..", 절대경로, 드라이브 문자 등 제거).
 * chrome.downloads의 filename은 Chrome 다운로드 폴더 기준 상대 경로만 허용한다.
 */
function normalizeSubfolder(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .map((part) => part.trim().replace(/[<>:"|?*]/g, '_'))
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/**
 * 파일 이름으로 쓸 수 없는 문자(Windows 금지 문자 + 제어 문자)를 하이픈으로 바꾼다. Soop 공식
 * 다운로드도 같은 방식이라 이 규칙에 맞춰야 하고, 안 바꾸면 chrome.downloads가 "Invalid filename"
 * 으로 실패하거나 Chrome이 임의로 바꿔 저장한다. 파일 이름 부분에만 쓴다(경로 구분자 포함).
 * 업로드용 제목에는 쓰지 않는다 — 제목은 치환 전 원본 이름을 그대로 쓴다.
 * (youtubeStudio.js의 buildNameMatchers가 같은 규칙으로 저장된 이름을 추정한다.)
 */
function sanitizeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

// 다운로드가 끝나면 브라우저가 실제로 저장한 파일 이름을 기록해둔다. 특수문자 치환이나
// 중복 시 "(1)" 접미사 때문에 Soop이 알려준 이름과 달라질 수 있어서, 업로드 때 Studio에
// 자동 첨부할 파일을 찾는 데 이 이름을 쓴다. 서비스 워커는 다운로드 도중 종료될 수 있어
// 추적 정보는 메모리가 아니라 chrome.storage.local에 둔다.
async function trackDownload(downloadId, videoId, fileOrder) {
  const { pendingDownloads = {} } = await chrome.storage.local.get(['pendingDownloads']);
  pendingDownloads[downloadId] = { videoId, fileOrder: Number(fileOrder) };
  await chrome.storage.local.set({ pendingDownloads });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const { pendingDownloads = {}, downloadedFiles = {} } = await chrome.storage.local.get([
    'pendingDownloads',
    'downloadedFiles',
  ]);
  const tracked = pendingDownloads[delta.id];
  if (!tracked) return;
  delete pendingDownloads[delta.id];

  if (state === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item?.filename) {
      const name = item.filename.split(/[\\/]/).pop();
      downloadedFiles[`${tracked.videoId}:${tracked.fileOrder}`] = { name, savedAt: Date.now() };
      console.log(`${STUDIO_LOG_TAG} 다운로드 완료 기록: ${tracked.videoId}:${tracked.fileOrder} → ${name}`);
    }
  }
  await chrome.storage.local.set({ pendingDownloads, downloadedFiles });
});

/**
 * 새로 연 라이브 탭에 주었던 임시 포커스를 원래 보고 있던 탭으로 되돌립니다.
 * @param {number} newTabId
 */
async function restoreFocus(newTabId) {
  if (!pendingFocusRestore.has(newTabId)) return;
  const previousActiveTabId = pendingFocusRestore.get(newTabId);
  pendingFocusRestore.delete(newTabId);
  if (previousActiveTabId == null) return;

  try {
    await chrome.tabs.update(previousActiveTabId, { active: true });
    console.log(`${LOG_TAG} 포커스 복귀 완료 (tabId=${previousActiveTabId})`);
  } catch (error) {
    console.log(`${LOG_TAG} 포커스 복귀 실패 (이전 탭이 이미 닫혔을 수 있음, tabId=${previousActiveTabId})`);
  }
}

/**
 * 라이브인데 감시 중인 탭이 없는 스트리머를 찾아 새 탭을 (재)생성합니다.
 * 최초로 방송을 켠 경우와, 감시 탭이 방송 중 예기치 않게 닫힌 경우를 동일하게 처리합니다.
 */
async function runLiveCheck() {
  const startedAt = new Date().toISOString();
  const settings = await getSettings();
  const { autoLiveOpen } = settings.features;

  if (!autoLiveOpen.enabled) {
    console.log(`${LOG_TAG} ${startedAt} 감시 건너뜀 (기능 꺼짐)`);
    return;
  }

  const streamers = (autoLiveOpen.streamers || []).filter((s) => s?.id && s.enabled !== false);
  if (streamers.length === 0) {
    console.log(`${LOG_TAG} ${startedAt} 감시 건너뜀 (등록된 스트리머 없음)`);
    return;
  }

  const monitoredTabs = await getMonitoredTabs();
  const monitoredStreamerIds = new Set(Object.values(monitoredTabs));

  console.log(
    `${LOG_TAG} ${startedAt} 조회 시작 - 대상: [${streamers.map((s) => s.id).join(', ')}]`
  );

  for (const streamer of streamers) {
    if (monitoredStreamerIds.has(streamer.id)) {
      console.log(`${LOG_TAG} ${streamer.id} - 조회 생략 (이미 감시 중인 탭 있음)`);
      continue;
    }

    try {
      const live = await isStreamerLive(streamer.id);
      console.log(`${LOG_TAG} ${streamer.id} - 라이브 상태: ${live ? '방송 중' : '방송 종료/오프라인'}`);
      if (!live) continue;

      // Soop 플레이어가 탭이 실제로 활성화된 상태에서만 스트리밍을 시작하는 것으로 보여
      // 잠깐 포커스를 준 뒤, 재생이 시작되면(or 최대 대기 시간 후) 원래 탭으로 되돌린다.
      const [previousActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = await chrome.tabs.create({
        url: `https://play.sooplive.com/${encodeURIComponent(streamer.id)}`,
        active: true,
      });
      monitoredTabs[tab.id] = streamer.id;
      await setMonitoredTabs(monitoredTabs);

      pendingFocusRestore.set(tab.id, previousActiveTab?.id ?? null);
      setTimeout(() => restoreFocus(tab.id), FOCUS_RESTORE_FALLBACK_MS);

      console.log(`${LOG_TAG} ${streamer.id} - 새 탭 생성 (tabId=${tab.id}), 라이브 감지 → 자동 오픈`);
    } catch (error) {
      console.error(`${LOG_TAG} ${streamer.id} - 라이브 체크 오류:`, error);
    }
  }

  console.log(`${LOG_TAG} 조회 종료`);
}

/**
 * 설정의 pollIntervalMinutes에 맞춰 알람을 (재)생성합니다.
 */
async function syncLiveCheckAlarm() {
  const settings = await getSettings();
  const periodInMinutes = Math.max(
    MIN_POLL_INTERVAL_MINUTES,
    Number(settings.features.autoLiveOpen.pollIntervalMinutes) || MIN_POLL_INTERVAL_MINUTES
  );
  await chrome.alarms.create(LIVE_CHECK_ALARM_NAME, { periodInMinutes });
  console.log(`${LOG_TAG} 감시 알람 설정 (주기: ${periodInMinutes}분)`);
}

// 확장 프로그램 설치 시
chrome.runtime.onInstalled.addListener(async () => {
  console.log('나만의 SOOP 확프 확장 프로그램이 설치되었습니다.');
  await migrateLegacySettingsIfNeeded();
  await syncLiveCheckAlarm();
  runLiveCheck();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncLiveCheckAlarm();
  runLiveCheck();
});

// 아이콘 클릭 시 설정 페이지 열기 (default_popup이 없으므로 onClicked가 정상 동작)
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LIVE_CHECK_ALARM_NAME) {
    console.log(`${LOG_TAG} 알람 발생 - 주기적 조회 시작`);
    runLiveCheck();
  }
});

// 설정 페이지에서 감시 주기/스트리머 목록이 바뀌면 알람을 갱신하고 즉시 한 번 확인합니다.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings) return;
  console.log(`${LOG_TAG} 설정 변경 감지 - 알람 갱신 및 즉시 조회`);
  syncLiveCheckAlarm();
  runLiveCheck();
});

// 감시 중이던 탭이 닫히면 목록에서 제거합니다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const monitoredTabs = await getMonitoredTabs();
  if (tabId in monitoredTabs) {
    console.log(`${LOG_TAG} ${monitoredTabs[tabId]} - 감시 탭 종료됨 (tabId=${tabId}), 목록에서 제거`);
    delete monitoredTabs[tabId];
    await setMonitoredTabs(monitoredTabs);
  }
});

// 업로드 창으로 열었던 Studio 탭이 닫히면 보관 중이던 제목/설명도 정리합니다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingStudioUploads();
  if (tabId in pending) {
    delete pending[tabId];
    await setPendingStudioUploads(pending);
  }
});

// 메시지 리스너
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    sendResponse({ status: 'active' });
    return true;
  }

  if (request.action === 'liveMonitor:init') {
    (async () => {
      const tabId = sender.tab?.id;
      const monitoredTabs = await getMonitoredTabs();
      const streamerId = tabId != null ? monitoredTabs[tabId] : undefined;
      if (!streamerId) {
        console.log(`${LOG_TAG} liveMonitor:init - 감시 대상 아님 (tabId=${tabId})`);
        sendResponse({ monitored: false });
        return;
      }
      const settings = await getSettings();
      console.log(`${LOG_TAG} ${streamerId} - liveMonitor:init - 감시 대상 탭 확인됨 (tabId=${tabId})`);
      sendResponse({
        monitored: true,
        streamerId,
        autoCloseDelaySeconds: settings.features.autoLiveOpen.autoCloseDelaySeconds,
      });
    })();
    return true;
  }

  if (request.action === 'liveMonitor:playbackStarted') {
    const tabId = sender.tab?.id;
    console.log(`${LOG_TAG} 재생 시작 확인됨 (tabId=${tabId}) - 원래 탭으로 포커스 복귀`);
    if (tabId != null) restoreFocus(tabId);
    return false;
  }

  if (request.action === 'liveMonitor:checkStillLive') {
    (async () => {
      const live = await isStreamerLive(request.streamerId);
      console.log(
        `${LOG_TAG} ${request.streamerId} - 재생 중단 감지로 재확인 - 라이브 상태: ${live ? '방송 중 (새로고침 시도)' : '방송 종료 (탭 닫기 진행)'}`
      );
      sendResponse({ live });
    })();
    return true;
  }

  if (request.action === 'liveMonitor:closeTab') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        console.log(`${LOG_TAG} 탭 자동 닫기 실행 (tabId=${tabId})`);
        try {
          await chrome.tabs.remove(tabId);
        } catch (error) {
          console.error(`${LOG_TAG} 탭 닫기 오류:`, error);
        }
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'pointStatus:fetch') {
    (async () => {
      try {
        const loginId = await getLoginId();
        if (!loginId) {
          sendResponse({
            success: false,
            error: '로그인 정보를 확인할 수 없습니다. Soop에 로그인되어 있는지 확인해주세요.',
          });
          return;
        }

        const data = await getMissionStatus(loginId, todayDateString());
        if (!data) {
          sendResponse({ success: false, error: '포인트 정보를 가져오지 못했습니다.' });
          return;
        }

        sendResponse({ success: true, data });
      } catch (error) {
        console.error('[pointStatus] 조회 오류:', error);
        sendResponse({ success: false, error: '포인트 정보를 가져오는 중 오류가 발생했습니다.' });
      }
    })();
    return true;
  }

  if (request.action === 'vodFileInfo:fetch') {
    (async () => {
      try {
        const data = await getSoopVodInfo(request.videoId);
        if (!data || !Array.isArray(data.files)) {
          sendResponse({ success: false, error: 'VOD 정보를 가져오지 못했습니다.' });
          return;
        }
        sendResponse({ success: true, data });
      } catch (error) {
        console.error('[vodFileInfo] 조회 오류:', error);
        sendResponse({ success: false, error: 'VOD 정보를 가져오는 중 오류가 발생했습니다.' });
      }
    })();
    return true;
  }

  if (request.action === 'youtubeStudio:open') {
    (async () => {
      try {
        const entry = {
          title: request.title,
          description: request.description,
          fileNames: Array.isArray(request.fileNames) ? request.fileNames : [],
        };

        // 이미 열려 있고 저장까지 끝난(놀고 있는) Studio 탭이 있으면 새 탭을 열지 않고
        // 그 탭에서 "동영상 업로드"만 다시 눌러 새 업로드 데이터로 이어서 진행한다.
        const reusedTabId = await tryReuseStudioTab(entry);
        if (reusedTabId != null) {
          console.log(`${STUDIO_LOG_TAG} 기존 Studio 탭 재사용 (tabId=${reusedTabId}), 제목: ${entry.title}`);
          sendResponse({ success: true, reused: true });
          return;
        }

        const tab = await chrome.tabs.create({ url: YOUTUBE_UPLOAD_PAGE_URL, active: true });
        const pending = await getPendingStudioUploads();
        pending[tab.id] = entry;
        await setPendingStudioUploads(pending);
        console.log(`${STUDIO_LOG_TAG} 업로드 탭 열림 (tabId=${tab.id}), 제목: ${request.title}`);
        sendResponse({ success: true, reused: false });
      } catch (error) {
        console.error(`${STUDIO_LOG_TAG} 업로드 탭 열기 오류:`, error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'youtubeStudio:init') {
    (async () => {
      const tabId = sender.tab?.id;
      const pending = await getPendingStudioUploads();
      const entry = tabId != null ? pending[tabId] : undefined;
      if (!entry) {
        sendResponse({ pending: false });
        return;
      }
      console.log(`${STUDIO_LOG_TAG} Studio 탭에 제목/설명/옵션 전달 (tabId=${tabId})`);
      sendResponse({ pending: true, ...(await buildStudioPayload(entry)) });
    })();
    return true;
  }

  if (request.action === 'download:start') {
    (async () => {
      try {
        const { vodFileInfo } = (await getSettings()).features;
        const subfolder = normalizeSubfolder(vodFileInfo.downloadSubfolder);
        const safeName = sanitizeFileName(request.filename);
        const downloadId = await chrome.downloads.download({
          url: request.url,
          filename: subfolder ? `${subfolder}/${safeName}` : safeName,
        });
        if (request.videoId != null && request.fileOrder != null) {
          await trackDownload(downloadId, request.videoId, request.fileOrder);
        }
        sendResponse({ success: true, downloadId });
      } catch (error) {
        console.error('[download] 다운로드 시작 오류:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  return false;
});
