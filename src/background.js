/**
 * Background Service Worker
 * 확장 프로그램의 백그라운드 작업을 처리합니다.
 */

import { isStreamerLive, getLoginId, getMissionStatus, getSoopVodInfo } from './soopLiveApi.js';
import { indexYoutubeUploads, matchVodFiles } from './youtubeMatch.js';

// 지금 로드된 게 최신 버전인지 콘솔에서 바로 확인할 수 있도록, 서비스 워커가 깨어날 때마다
// (설치/재시작/업데이트 후 첫 실행 포함) manifest.json의 version을 그대로 찍는다.
console.log(`[나만의 SOOP 확프] 백그라운드 시작 (v${chrome.runtime.getManifest().version})`);

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
      deleteLocalFileAfterUpload: false, // 업로드(파일 전송) 완료가 확인되면 로컬 mp4 자동 삭제. 기본 꺼짐(되돌릴 수 없음)
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

// 업로드 탭은 딱 하나만 두고 무조건 재사용한다(탭이 여러 개면 백그라운드 탭이 돼 렌더링/타이머가
// 느려지면서 자동화 버튼이 안 뜨는 문제가 있었다). 처리하지 못한 요청은 큐에 쌓아두고, 탭이
// 준비되는 대로(재사용 성공, 새로고침 후 재접속, 다음 알람 등) 순서대로 하나씩 배정한다.
async function getStudioTabId() {
  const { studioTabId } = await chrome.storage.session.get(['studioTabId']);
  return studioTabId ?? null;
}

async function setStudioTabId(studioTabId) {
  await chrome.storage.session.set({ studioTabId });
}

async function getStudioUploadQueue() {
  const { studioUploadQueue } = await chrome.storage.session.get(['studioUploadQueue']);
  return studioUploadQueue || [];
}

async function setStudioUploadQueue(studioUploadQueue) {
  await chrome.storage.session.set({ studioUploadQueue });
}

/** Studio 탭의 content script에 전달할 데이터(제목/설명/파일 후보/저장된 옵션)를 만든다. */
async function buildStudioPayload(entry) {
  const { vodFileInfo } = (await getSettings()).features;
  return {
    title: entry.title,
    description: entry.description,
    fileNames: entry.fileNames || [],
    // 자동 첨부가 실제로 성공했을 때만(=어느 로컬 파일인지 확실할 때만) "업로드 확인 후 삭제"를
    // 시도할 수 있어야 하므로, 그 파일을 정확히 지칭할 videoId/fileOrder를 같이 넘겨준다.
    videoId: entry.videoId ?? null,
    fileOrder: entry.fileOrder ?? null,
    downloadSubfolder: normalizeSubfolder(vodFileInfo.downloadSubfolder),
    options: {
      visibility: vodFileInfo.youtubeVisibility,
      notForKids: vodFileInfo.youtubeNotForKids,
      playlists: vodFileInfo.youtubePlaylists,
      deleteAfterUpload: vodFileInfo.deleteLocalFileAfterUpload,
    },
  };
}

/** 유튜브 Studio 탭을 통해 내 채널의 업로드 영상 목록을 가져온다. 열린 Studio 탭이 없으면 잠깐 열었다 닫는다. */
async function fetchYoutubeVideos() {
  const existing = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
  let tabId = existing.find((t) => /\/channel\/UC/.test(t.url || ''))?.id ?? existing[0]?.id;
  let createdTabId = null;
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: 'https://studio.youtube.com/', active: false });
    tabId = createdTabId = tab.id;
  }

  try {
    // 새로 연 탭은 content script/채널 페이지 리다이렉트가 준비될 때까지 몇 번 다시 시도한다.
    let lastError = '응답 없음';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await sendToTab(tabId, { action: 'youtubeVideos:list' }, 60000);
      if (res?.success) return res.videos;
      lastError = res?.error || '응답 없음';
      if (res && !String(res.error).startsWith('NO_CHANNEL')) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`유튜브 영상 목록을 가져오지 못했습니다: ${lastError}`);
  } finally {
    if (createdTabId != null) chrome.tabs.remove(createdTabId).catch(() => {});
  }
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

// 재사용 실패(탭은 idle로 보이는데 자동화가 안 먹힌 경우) 후 새로고침을 다시 시도하기까지
// 최소 간격 — 새로고침이 beforeunload 확인 창에 막히는 상황에서 매번 새 확인 창을 계속
//띄워 사용자를 귀찮게 하지 않기 위함.
const STUDIO_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;
let lastStudioReloadAttemptAt = 0;
let studioQueueDraining = false;

/**
 * 업로드 대기열을 앞에서부터 순서대로 처리한다. 재사용할 탭이 없으면(맨 처음, 또는 탭이
 * 닫혔으면) 이번 한 번만 새로 열고, 그 뒤로는 그 탭만 계속 재사용한다 — 탭을 여러 개
 * 띄우면 백그라운드 탭이 돼 렌더링/타이머가 느려지면서 자동화가 실패하는 문제가 있었다.
 * 탭이 idle로 보이는데(probe: reusable) 실제 재시작이 실패하면(아마 같은 이유로 버튼이
 * 아직 안 뜬 상태) 새로고침으로 복구를 시도한다. 새로고침 자체가 막히면(업로드 중이라
 * 나가기 확인 창이 뜨는 경우) 큐는 그대로 두고 물러난다 — 사용자가 그 확인 창을 해결해
 * 탭이 다시 로드되면 그 탭의 content script가 init()으로 큐 맨 앞 항목을 스스로 받아간다.
 */
async function drainStudioQueue() {
  if (studioQueueDraining) return;
  studioQueueDraining = true;
  try {
    for (;;) {
      const queue = await getStudioUploadQueue();
      if (queue.length === 0) break;
      const entry = queue[0];

      let tabId = await getStudioTabId();
      if (tabId != null) {
        try {
          await chrome.tabs.get(tabId);
        } catch (error) {
          tabId = null;
          await setStudioTabId(null);
        }
      }

      if (tabId == null) {
        const tab = await chrome.tabs.create({ url: YOUTUBE_UPLOAD_PAGE_URL, active: true });
        await setStudioTabId(tab.id);
        const pending = await getPendingStudioUploads();
        pending[tab.id] = entry;
        await setPendingStudioUploads(pending);
        await setStudioUploadQueue(queue.slice(1));
        console.log(`${STUDIO_LOG_TAG} 새 Studio 탭 생성 (tabId=${tab.id}), 제목: ${entry.title}`);
        continue;
      }

      const payload = await buildStudioPayload(entry);
      const probe = await sendToTab(tabId, { action: 'youtubeStudio:probe' }, 2000);
      if (!probe?.reusable) break; // 아직 바쁨(정상) — 나중에(becameIdle/새 요청/알람) 다시 시도

      const result = await sendToTab(tabId, { action: 'youtubeStudio:restart', payload }, 25000);
      if (result?.started) {
        const pending = await getPendingStudioUploads();
        pending[tabId] = entry; // 탭이 새로고침돼도 최신 업로드 데이터로 이어지게 갱신
        await setPendingStudioUploads(pending);
        await chrome.tabs.update(tabId, { active: true });
        try {
          const tab = await chrome.tabs.get(tabId);
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (error) {
          // 포커스만 실패한 것 — 업로드 자체는 이미 시작됐으니 무시
        }
        await setStudioUploadQueue(queue.slice(1));
        console.log(`${STUDIO_LOG_TAG} 기존 Studio 탭 재사용 (tabId=${tabId}), 제목: ${entry.title}`);
        continue;
      }

      console.warn(`${STUDIO_LOG_TAG} 탭이 idle로 보이는데 재사용 실패(${result?.reason || '응답 없음'}) — 새로고침으로 복구 시도`);
      const now = Date.now();
      if (now - lastStudioReloadAttemptAt < STUDIO_RELOAD_COOLDOWN_MS) break;
      lastStudioReloadAttemptAt = now;
      try {
        await chrome.tabs.reload(tabId);
      } catch (error) {
        console.warn(`${STUDIO_LOG_TAG} 탭 새로고침 요청 실패:`, error.message);
      }
      // 큐는 건드리지 않고 물러난다. 새로고침이 실제로 진행됐다면 그 탭이 다시 뜬 뒤
      // youtubeStudio:init에서 큐 맨 앞 항목을 스스로 받아간다(아래 핸들러 참고). 업로드
      // 중이라 확인 창에 막혔다면 사용자가 해결한 뒤 같은 방식으로 이어진다.
      break;
    }
  } finally {
    studioQueueDraining = false;
  }
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

// "모두 다운로드&업로드" 배치가 특정 다운로드의 완료(성공/실패)를 확인하려고 기다리는 곳.
// downloadId별로 짧게 살다 사라지는 값이라 서비스 워커 메모리가 아니라 chrome.storage.local에
// 두고, content script(vodFileInfo.js)가 직접 폴링해서 읽은 뒤 지운다. 배치를 쓰지 않는 평소
// 수동 다운로드는 이 값을 아무도 읽지 않으므로, 여기서 오래된 항목을 그때그때 정리한다.
const DOWNLOAD_OUTCOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pruneOldDownloadOutcomes(downloadOutcomes) {
  const cutoff = Date.now() - DOWNLOAD_OUTCOME_MAX_AGE_MS;
  for (const [id, outcome] of Object.entries(downloadOutcomes)) {
    if (!outcome.recordedAt || outcome.recordedAt < cutoff) delete downloadOutcomes[id];
  }
}

/**
 * 패널에 보여줄 저장 공간 정보. Chrome은 디스크 "남은 용량"을 주지 않아(getAvailableCapacity가
 * 정식 버전에 없음) 디스크별 전체 용량과, 이 확장이 받아서 지금도 남아 있는 파일의 개수·합계
 * 크기만 돌려준다. 디스크 이름은 NUL로 채워져 오므로 쓰지 않는다.
 */
async function getStorageOverview() {
  const disks = await new Promise((resolve) => {
    try {
      chrome.system.storage.getInfo((units) => resolve(chrome.runtime.lastError ? [] : units || []));
    } catch (error) {
      resolve([]);
    }
  });

  const { vodFileInfo } = (await getSettings()).features;
  const subfolder = normalizeSubfolder(vodFileInfo.downloadSubfolder);
  const { downloadedFiles = {} } = await chrome.storage.local.get(['downloadedFiles']);
  // 이미 지운 것으로 기록된 파일은 제외한다 — chrome.downloads의 exists 갱신이
  // 최대 10초 지연될 수 있어(문서 기준), 우리가 확실히 아는 삭제를 우선한다.
  const knownNames = new Set(
    Object.values(downloadedFiles)
      .filter((f) => !f.deletedAt)
      .map((f) => f.name)
  );

  const items = await chrome.downloads.search({ state: 'complete', exists: true, limit: 0 });
  const mine = items.filter((item) => {
    const path = String(item.filename || '').replace(/\\/g, '/');
    const name = path.split('/').pop();
    if (!knownNames.has(name)) return false;
    return !subfolder || path.includes(`/${subfolder}/`);
  });

  return {
    disks: disks.map((d) => ({ type: d.type, capacity: d.capacity })),
    files: { count: mine.length, bytes: mine.reduce((sum, item) => sum + Math.max(item.fileSize || 0, 0), 0) },
  };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const { pendingDownloads = {}, downloadedFiles = {}, downloadOutcomes = {} } = await chrome.storage.local.get([
    'pendingDownloads',
    'downloadedFiles',
    'downloadOutcomes',
  ]);
  const tracked = pendingDownloads[delta.id];
  if (!tracked) return;
  delete pendingDownloads[delta.id];
  pruneOldDownloadOutcomes(downloadOutcomes);

  if (state === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item?.filename) {
      const name = item.filename.split(/[\\/]/).pop();
      // downloadId를 같이 기록해두면 나중에 "업로드 확인 후 자동 삭제"에서 파일명으로 다시
      // 찾을 필요 없이 chrome.downloads.removeFile(downloadId)로 바로, 정확하게 지울 수 있다.
      downloadedFiles[`${tracked.videoId}:${tracked.fileOrder}`] = { name, savedAt: Date.now(), downloadId: delta.id };
      downloadOutcomes[delta.id] = { ok: true, name, recordedAt: Date.now() };
      console.log(`${STUDIO_LOG_TAG} 다운로드 완료 기록: ${tracked.videoId}:${tracked.fileOrder} → ${name}`);
    } else {
      downloadOutcomes[delta.id] = { ok: false, error: '저장된 파일 정보를 찾지 못함', recordedAt: Date.now() };
    }
  } else {
    downloadOutcomes[delta.id] = { ok: false, error: delta.error?.current || '다운로드 중단됨', recordedAt: Date.now() };
  }
  await chrome.storage.local.set({ pendingDownloads, downloadedFiles, downloadOutcomes });
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
    // Studio 업로드 대기열이 남아 있는데(예: 새로고침이 확인 창에 막혀서) 아무 신호도 못
    // 받았을 경우를 대비한 안전망. 큐가 비어 있으면 drainStudioQueue가 바로 끝난다.
    drainStudioQueue();
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
  // 재사용 대상 탭 자체가 닫혔다면 기록을 지워서, 다음 대기열 처리 때 새 탭을 하나 연다.
  if ((await getStudioTabId()) === tabId) {
    await setStudioTabId(null);
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
          videoId: request.videoId ?? null,
          fileOrder: request.fileOrder != null ? Number(request.fileOrder) : null,
        };

        // 무조건 대기열에 넣고 나서 처리를 시도한다 — 탭이 이미 바쁘면(정상) 대기열에
        // 그대로 남아 있다가 순서대로 처리된다. 탭을 여러 개 띄우지 않는다(항상 하나만
        // 재사용, 없을 때만 딱 한 번 새로 연다).
        const queue = await getStudioUploadQueue();
        queue.push(entry);
        await setStudioUploadQueue(queue);
        console.log(`${STUDIO_LOG_TAG} 업로드 대기열에 추가 (대기 ${queue.length}개), 제목: ${entry.title}`);
        sendResponse({ success: true, queued: true });
      } catch (error) {
        console.error(`${STUDIO_LOG_TAG} 업로드 요청 처리 오류:`, error);
        sendResponse({ success: false, error: error.message });
      }
      drainStudioQueue(); // 응답은 이미 보냈으니 결과를 기다리지 않고 바로 처리 시도
    })();
    return true;
  }

  if (request.action === 'youtubeStudio:becameIdle') {
    // 어떤 Studio 탭이 저장까지 마치고 놀고 있는 상태가 됐다는 신호 — 대기열에 남은 게
    // 있으면 다음 알람/요청을 기다리지 않고 바로 이어서 처리한다.
    drainStudioQueue();
    return false;
  }

  if (request.action === 'youtubeStudio:init') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ pending: false });
        return;
      }

      const pending = await getPendingStudioUploads();
      let entry = pending[tabId];

      if (!entry) {
        // 이 탭에 아직 배정된 항목이 없다 — 우리가 재사용하려는 그 탭이거나(새로고침 직후 등)
        // 탭이 아직 없어서 방금 새로 연 탭이라면, 대기열 맨 앞 항목을 지금 바로 배정한다.
        const studioTabId = await getStudioTabId();
        if (studioTabId == null || studioTabId === tabId) {
          const queue = await getStudioUploadQueue();
          if (queue.length > 0) {
            entry = queue[0];
            await setStudioUploadQueue(queue.slice(1));
            pending[tabId] = entry;
            await setPendingStudioUploads(pending);
            if (studioTabId == null) await setStudioTabId(tabId);
          }
        }
      }

      if (!entry) {
        const managed = (await getStudioTabId()) === tabId;
        sendResponse({ pending: false, managed });
        return;
      }
      console.log(`${STUDIO_LOG_TAG} Studio 탭에 제목/설명/옵션 전달 (tabId=${tabId})`);
      sendResponse({ pending: true, ...(await buildStudioPayload(entry)) });
    })();
    return true;
  }

  // 목록 페이지에서 넘어온 VOD 아이디들을, 실제 유튜브 업로드 영상(설명의 Soop 링크 + 제목의 (n/max))과
  // 대조해 파일별 업로드 여부와 유튜브 링크를 돌려준다.
  if (request.action === 'vodUpload:match') {
    (async () => {
      try {
        const videoIds = Array.isArray(request.videoIds) ? request.videoIds.map(String) : [];
        const youtubeVideos = await fetchYoutubeVideos();
        const index = indexYoutubeUploads(youtubeVideos);
        const vods = [];
        for (const videoId of videoIds) {
          const data = await getSoopVodInfo(videoId).catch(() => null);
          if (!data || !Array.isArray(data.files)) {
            vods.push({ videoId, error: 'VOD 정보 조회 실패' });
            continue;
          }
          vods.push(matchVodFiles(videoId, data.files, index));
        }
        sendResponse({ success: true, vods, youtubeVideoCount: youtubeVideos.length });
      } catch (error) {
        console.error('[vodUpload] 유튜브 매칭 오류:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'download:cancel') {
    chrome.downloads
      .cancel(Number(request.downloadId))
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'download:deleteUploaded') {
    (async () => {
      try {
        const key = `${request.videoId}:${Number(request.fileOrder)}`;
        const { downloadedFiles = {} } = await chrome.storage.local.get(['downloadedFiles']);
        const record = downloadedFiles[key];
        // downloadId로 기록해둔 "바로 그 파일"만 지운다 — 파일명 재검색 같은 추측성 매칭은
        // 절대 하지 않는다(비슷한 이름의 다른 파일을 잘못 지우면 되돌릴 수 없다).
        if (!record?.downloadId) {
          sendResponse({ success: false, error: '삭제할 다운로드 기록을 찾지 못함' });
          return;
        }
        if (record.deletedAt) {
          sendResponse({ success: true, alreadyDeleted: true });
          return;
        }

        await new Promise((resolve, reject) => {
          chrome.downloads.removeFile(record.downloadId, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });

        downloadedFiles[key] = { ...record, deletedAt: Date.now() };
        await chrome.storage.local.set({ downloadedFiles });
        console.log(`${STUDIO_LOG_TAG} 업로드 확인 후 로컬 파일 삭제: ${key} → ${record.name}`);
        sendResponse({ success: true, name: record.name });
      } catch (error) {
        console.error(`${STUDIO_LOG_TAG} 로컬 파일 삭제 실패:`, error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'storage:overview') {
    getStorageOverview()
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
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
