/**
 * Background Service Worker
 * 확장 프로그램의 백그라운드 작업을 처리합니다.
 */

import { isStreamerLive, getLoginId, getMissionStatus, getSoopVodInfo, getBalloonPage } from './soopLiveApi.js';
import { indexYoutubeUploads, matchVodFiles } from './youtubeMatch.js';
import { parseBalloonPage } from './balloonParser.js';

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
    balloonSync: {
      webAppUrl: '', // Apps Script 웹앱 배포 URL (secret/Code.gs의 doPost)
      token: '', // 웹앱 Script Property SYNC_TOKEN과 같은 값
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

// ---------------------------------------------------------------------------
// 탭 하나를 열어두고 재사용하면서 메시지를 "확실히" 전달하는 공용 로직. Studio 탭(업로드
// 자동화)과 다시보기 플레이어 탭(배치) 둘 다 "탭을 하나만 두고 계속 재사용"하는 같은
// 정책을 쓰므로 이 두 함수로 통일한다. 큐/바쁜지 확인(probe) 같은 건 없다 — 받는 쪽
// content script가 자기 몫의 순서 관리(요청 큐)를 스스로 하기 때문에, 여기서는 "탭이
// 있는지, 로드가 끝났는지"만 신경 쓰면 된다.
// ---------------------------------------------------------------------------

/** 탭이 막 생성/네비게이션된 직후엔 content script가 아직 리스너를 안 걸었을 수 있어, 로드
 *  완료(status: 'complete')까지 기다린 뒤에 메시지를 보낸다. 완료 신호를 놓칠 경우를 대비해
 *  타임아웃도 둔다. */
function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish();
      })
      .catch(finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** 로드 완료 직후에도 content script 등록에 약간의 지연이 있을 수 있어, 전송 자체도 몇 차례
 *  재시도한다(짧은 간격으로). */
async function sendWithRetry(tabId, message, attempts = 8, intervalMs = 400) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return false;
}

/**
 * 저장해둔 tabId가 있으면(존재 확인 후) 그대로 쓰고, 없으면 새로 열어 저장한다.
 * `navigateIfExists`가 true면 이미 있는 탭도 매번 그 url로 이동시킨다(다시보기 플레이어
 * 탭처럼 "다음 작업 대상"이 바뀌는 경우). false면 한 번 연 뒤로는 그대로 둔다(Studio 탭처럼
 * 같은 페이지에 여러 요청을 계속 흘려보내는 경우 — 매번 새로고침하면 그때마다 처리 중이던
 * 자동화가 끊긴다). 새로 열거나 이동시킨 경우에만 로드 완료를 기다린다.
 */
async function ensureTabAt(getTabId, setTabId, url, { navigateIfExists = false } = {}) {
  let tabId = await getTabId();
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
    } catch (error) {
      tabId = null;
      await setTabId(null);
    }
  }

  if (tabId == null) {
    const tab = await chrome.tabs.create({ url, active: true });
    await setTabId(tab.id);
    await waitForTabLoad(tab.id);
    return tab.id;
  }

  if (navigateIfExists) {
    await chrome.tabs.update(tabId, { url, active: true });
    await waitForTabLoad(tabId);
  }
  return tabId;
}

// ---------------------------------------------------------------------------
// YouTube Studio 업로드 자동화 탭. 탭은 하나만 두고 계속 재사용한다(여러 개면 백그라운드
// 탭이 돼 렌더링/타이머가 느려지면서 자동화 버튼이 안 뜨는 문제가 실제로 있었다). 업로드
// 요청의 순서 관리(큐)는 youtubeStudio.js 쪽에서 전담하므로, 여기서는 그 탭 하나에 요청을
// 확실히 전달하는 것까지만 책임진다 — "지금 바쁜지" 확인(probe)이나 재시작 요청 같은 건 없다.
// ---------------------------------------------------------------------------
const STUDIO_LOG_TAG = '[YoutubeStudio]';
const YOUTUBE_UPLOAD_PAGE_URL = 'https://www.youtube.com/upload';

async function getStudioTabId() {
  const { studioTabId } = await chrome.storage.session.get(['studioTabId']);
  return studioTabId ?? null;
}

async function setStudioTabId(studioTabId) {
  await chrome.storage.session.set({ studioTabId });
}

/** 업로드 요청 하나를 Studio 탭에 전달한다. 실패하면(탭이 죽어있었던 경우 등) 탭을 완전히
 *  새로 열어 한 번 더 시도한다. */
async function deliverStudioRequest(payload) {
  let tabId = await ensureTabAt(getStudioTabId, setStudioTabId, YOUTUBE_UPLOAD_PAGE_URL, { navigateIfExists: false });
  let delivered = await sendWithRetry(tabId, { action: 'studio:newRequest', payload });
  if (delivered) return;

  console.warn(`${STUDIO_LOG_TAG} 요청 전달 실패 — 탭을 새로 열어 재시도`);
  await setStudioTabId(null);
  tabId = await ensureTabAt(getStudioTabId, setStudioTabId, YOUTUBE_UPLOAD_PAGE_URL, { navigateIfExists: false });
  await sendWithRetry(tabId, { action: 'studio:newRequest', payload });
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

// ---------------------------------------------------------------------------
// 다시보기 배치: 다시보기 목록 페이지(vodList.js)가 미업로드 다시보기들을 순서대로 하나씩
// 맡긴다. 큐(어떤 다시보기를 언제 처리할지)는 vodList.js 자신이 들고 돈다 — background는
// "플레이어 탭 하나를 그 다시보기로 열어주고, 끝나면 결과를 돌려주는" 중계만 한다.
//   1. vodList.js → background: vodBatch:start {videoId, skipFileOrders}
//   2. background가 플레이어 탭을 그 videoId로 열거나 이동시키고 vodBatch:begin 전달
//   3. vodFileInfo.js가 로컬 단계(다운로드+Studio 업로드 요청)를 끝내자마자(Studio 쪽 실제
//      전송 확인은 기다리지 않음) vodBatch:complete를 background로 보냄
//   4. background가 그 요청을 보냈던 탭(vodList.js)에 그대로 전달 + 실패 있으면 기록/알림
// ---------------------------------------------------------------------------
const VOD_PLAYER_URL_PREFIX = 'https://vod.sooplive.com/player/';

async function getPlayerTabId() {
  const { playerTabId } = await chrome.storage.session.get(['playerTabId']);
  return playerTabId ?? null;
}

async function setPlayerTabId(playerTabId) {
  await chrome.storage.session.set({ playerTabId });
}

/** 지금 진행 중인 배치를 요청한 vodList.js 탭 — 완료 알림을 돌려줄 곳. 동시에 하나의
 *  다시보기만 처리하므로(vodList.js가 순서대로 하나씩 보냄) 단일 슬롯으로 충분하다. */
async function getVodBatchRequest() {
  const { vodBatchRequest } = await chrome.storage.session.get(['vodBatchRequest']);
  return vodBatchRequest || null;
}

async function setVodBatchRequest(vodBatchRequest) {
  await chrome.storage.session.set({ vodBatchRequest });
}

// ---------------------------------------------------------------------------
// 실패 기록: 파일 하나가 실패하면 반드시 사용자가 알 수 있어야 한다 — 콘솔 로그 외에
// (1) chrome.storage.local에 남는 영구 히스토리와 (2) chrome.notifications 데스크톱 알림
// 두 가지를 더한다. 알림 아이콘은 별도 이미지 파일 없이 작은 빨간 원을 데이터 URL로
// 인라인했다.
// ---------------------------------------------------------------------------
const VOD_BATCH_LOG_TAG = '[VodBatch]';
const PIPELINE_FAILURE_HISTORY_MAX = 200;
const PIPELINE_FAILURE_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbklEQVR4nO3UwQ0AIAgEQauh/4LsRQtQiQgHGrmE986LUl5bJWrchUShmNO4GqENqyDWcRECFd9GhALQcRbhFV8i/gZ4xwdEAhKQgHBA+CNKgDdiGvdCsPErAEjEVhyFEMUtIcdhC4RJXIqBRJHrRq8Fb3n0ggwAAAAASUVORK5CYII=';

function formatPipelineFailureMessage(entry) {
  return `다시보기 ${entry.videoId}의 파일(${entry.fileOrder}번) 실패: ${entry.reason}`;
}

/**
 * 실패 하나를 영구 히스토리에 남기고(chrome.storage.local, 최대 200개 — 오래된 것부터
 * 버림), 데스크톱 알림을 띄운다. entry: { videoId, fileOrder, reason }.
 */
async function recordPipelineFailure(entry) {
  const record = { at: Date.now(), ...entry };
  console.warn(`${VOD_BATCH_LOG_TAG} 실패 기록:`, record);

  try {
    const { pipelineFailureHistory = [] } = await chrome.storage.local.get(['pipelineFailureHistory']);
    pipelineFailureHistory.push(record);
    while (pipelineFailureHistory.length > PIPELINE_FAILURE_HISTORY_MAX) pipelineFailureHistory.shift();
    await chrome.storage.local.set({ pipelineFailureHistory });
  } catch (error) {
    console.warn(`${VOD_BATCH_LOG_TAG} 실패 히스토리 저장 오류:`, error.message);
  }

  try {
    await chrome.notifications.create('', {
      type: 'basic',
      iconUrl: PIPELINE_FAILURE_ICON_DATA_URL,
      title: '다시보기 배치 실패',
      message: formatPipelineFailureMessage(record),
      priority: 1,
    });
  } catch (error) {
    console.warn(`${VOD_BATCH_LOG_TAG} 알림 생성 실패:`, error.message);
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

// Studio 업로드 탭이 닫히면 기록을 지워서, 다음 요청 때 새 탭을 하나 연다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getStudioTabId()) === tabId) {
    await setStudioTabId(null);
  }
});

// 다시보기 배치가 쓰던 플레이어 탭이 사용자에 의해 닫히면, 기록을 지우고(다음 배치는 새
// 탭을 연다) 지금 그 배치를 기다리고 있던 vodList.js 탭에 "취소됨"으로 완료를 알려줘서
// 영원히 응답을 기다리지 않게 한다.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getPlayerTabId()) !== tabId) return;
  await setPlayerTabId(null);
  const batchRequest = await getVodBatchRequest();
  if (batchRequest?.requesterTabId != null) {
    sendToTab(
      batchRequest.requesterTabId,
      { action: 'vodBatch:complete', videoId: batchRequest.videoId, successOrders: [], failOrders: [], cancelled: true },
      2000
    );
    await setVodBatchRequest(null);
  }
});

// 메시지 리스너
// ---------------------------------------------------------------------------
// 별풍선 이력 동기화: SOOP 포인트 페이지 내역을 가져와 Apps Script 웹앱으로 보낸다. 웹앱이
// 시트에 중복 없이 추가하고 main을 갱신한다(secret/Code.gs의 doPost). 수집은 로그인 쿠키가
// 있는 이 확장에서만 가능하다 — Apps Script의 UrlFetchApp에는 사용자 세션이 없다.
// ---------------------------------------------------------------------------
const BALLOON_GIFT_SHEETS = { 1: '라이브', 2: '동영상', 3: '방송국', 7: '대결미션', 8: '도전미션' };
const BALLOON_PAGE_SIZE = 10;
const BALLOON_MAX_PAGES = 200;
const BALLOON_REQUEST_DELAY_MS = 400;

function balloonSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentKstYearMonth() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return { year: kst.getUTCFullYear(), month: kst.getUTCMonth() + 1 };
}

async function fetchBalloonPageParsed(params) {
  const parsed = parseBalloonPage(await getBalloonPage(params));
  if (Object.keys(parsed).length === 0) {
    throw new Error('별풍선 내역을 읽지 못했습니다. 로그인 상태나 페이지 구조를 확인해주세요.');
  }
  return parsed;
}

/** 선물 내역 한 gifttype의 전 페이지. 선물 내역은 연·월 필터가 없이 최근 3개월이 나온다. */
async function fetchBalloonGifts(gifttype, year, month, rowsBySheet, missions, seenSummaries) {
  const sheet = BALLOON_GIFT_SHEETS[gifttype];
  for (let page = 1; page <= BALLOON_MAX_PAGES; page += 1) {
    const parsed = await fetchBalloonPageParsed({ gifttype, year, month, currpageOut: page, currpageIn: 1 });
    const pageRows = parsed[sheet] || [];
    (rowsBySheet[sheet] ||= []).push(...pageRows);

    // 도전미션 요약 테이블은 페이지마다 같은 내용이 반복될 수 있어, 같은 요약이 두 번 나오면 한 번만 쓴다.
    const summary = parsed['도전미션누적'] || [];
    const signature = JSON.stringify(summary);
    if (summary.length > 0 && !seenSummaries.has(signature)) {
      seenSummaries.add(signature);
      missions.push(...summary);
    }

    if (pageRows.length < BALLOON_PAGE_SIZE) break;
    await balloonSleep(BALLOON_REQUEST_DELAY_MS);
  }
}

/** 구매 내역 한 달의 전 페이지. 구매 테이블은 year/month 셀렉트로 필터된다. */
async function fetchBalloonPurchases(year, month, rowsBySheet) {
  for (let page = 1; page <= BALLOON_MAX_PAGES; page += 1) {
    const parsed = await fetchBalloonPageParsed({ gifttype: 1, year, month, currpageOut: 1, currpageIn: page });
    const pageRows = parsed['구매'] || [];
    (rowsBySheet['구매'] ||= []).push(...pageRows);
    if (pageRows.length < BALLOON_PAGE_SIZE) break;
    await balloonSleep(BALLOON_REQUEST_DELAY_MS);
  }
}

async function postBalloonRows(rowsBySheet, missions) {
  const { balloonSync } = (await getSettings()).features;
  if (!balloonSync.webAppUrl || !balloonSync.token) {
    throw new Error('Apps Script 웹앱 URL과 토큰을 먼저 입력해주세요.');
  }
  const res = await fetch(balloonSync.webAppUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: balloonSync.token, rows: rowsBySheet, missions }),
  });
  let json;
  try {
    json = await res.json();
  } catch (_error) {
    throw new Error(`웹앱 응답을 해석하지 못했습니다 (HTTP ${res.status})`);
  }
  if (!json.ok) throw new Error(json.error || '웹앱 처리에 실패했습니다.');
  return json;
}

/** 최근 3개월 선물 내역 + 이번 달·지난달 구매 내역을 동기화한다. */
async function syncBalloonRecent() {
  const now = currentKstYearMonth();
  const previous = now.month === 1 ? { year: now.year - 1, month: 12 } : { year: now.year, month: now.month - 1 };
  const rowsBySheet = {};
  const missions = [];
  const seenSummaries = new Set();

  for (const gifttype of Object.keys(BALLOON_GIFT_SHEETS).map(Number)) {
    await fetchBalloonGifts(gifttype, now.year, now.month, rowsBySheet, missions, seenSummaries);
  }
  await fetchBalloonPurchases(now.year, now.month, rowsBySheet);
  await fetchBalloonPurchases(previous.year, previous.month, rowsBySheet);

  return postBalloonRows(rowsBySheet, missions);
}

/** 구매 내역 과거 backfill: 한 해(year)의 1~12월(이번 해면 이번 달까지) 구매 내역을 동기화한다. */
async function syncBalloonPurchasesOfYear(year) {
  const now = currentKstYearMonth();
  const lastMonth = year === now.year ? now.month : 12;
  const rowsBySheet = {};
  for (let month = 1; month <= lastMonth; month += 1) {
    await fetchBalloonPurchases(year, month, rowsBySheet);
  }
  return postBalloonRows(rowsBySheet, []);
}

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

  // vodFileInfo.js의 "유튜브에 업로드" — Studio 탭에 자동 입력할 데이터를 전달한다. 순서
  // 관리는 youtubeStudio.js 내부 큐가 하므로 여기서는 설정값을 합쳐 바로 전달만 시도한다.
  if (request.action === 'studio:upload') {
    (async () => {
      try {
        const { vodFileInfo } = (await getSettings()).features;
        const payload = {
          title: request.title,
          description: request.description,
          fileNames: Array.isArray(request.fileNames) ? request.fileNames : [],
          videoId: request.videoId ?? null,
          fileOrder: request.fileOrder != null ? Number(request.fileOrder) : null,
          downloadSubfolder: normalizeSubfolder(vodFileInfo.downloadSubfolder),
          options: {
            visibility: vodFileInfo.youtubeVisibility,
            notForKids: vodFileInfo.youtubeNotForKids,
            playlists: vodFileInfo.youtubePlaylists,
            deleteAfterUpload: vodFileInfo.deleteLocalFileAfterUpload,
          },
        };
        sendResponse({ success: true });
        deliverStudioRequest(payload); // 응답은 이미 보냈으니 결과를 기다리지 않고 전달 시도
      } catch (error) {
        console.error(`${STUDIO_LOG_TAG} 업로드 요청 처리 오류:`, error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // youtubeStudio.js가 5회 연속 진전 없는 실패로 "수동 대기 상태"에 들어갔다는 신호 —
  // 이 탭은 더 이상 자동 처리를 하지 않으므로(사용자가 직접 확인하도록 열어둔 채 둔다),
  // 다음 요청부터는 새 탭을 연다. 그 탭이 처리하지 못하고 들고 있던 요청들도 같이
  // 돌려받아서, 새로 열릴 탭에 순서대로 다시 전달한다.
  if (request.action === 'studio:tabUnusable') {
    (async () => {
      console.warn(`${STUDIO_LOG_TAG} 탭이 수동 대기 상태로 전환됨 — 다음 요청부터 새 탭 사용 (tabId=${sender.tab?.id})`);
      await setStudioTabId(null);
      const leftovers = Array.isArray(request.leftoverRequests) ? request.leftoverRequests : [];
      for (const payload of leftovers) {
        await deliverStudioRequest(payload);
      }
    })();
    return false;
  }

  // "모두 폐기" — 지금 아는 Studio 탭이 있으면 그 탭에 전달해 아직 시작 안 한 대기열만
  // 지우게 한다(지금 자동화 중인 건 그대로 둔다). 모르는 탭이면(애초에 아무것도 없음) 그냥 끝.
  if (request.action === 'studio:discardQueued') {
    (async () => {
      const tabId = await getStudioTabId();
      if (tabId != null) sendToTab(tabId, { action: 'studio:discardQueued' }, 2000);
      sendResponse({ success: true });
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

  // 목록 페이지의 "모두 업로드"가 다시보기 하나를 순서대로 맡긴다. 큐(다음엔 뭘 할지)는
  // vodList.js가 들고 있으므로, 여기서는 플레이어 탭을 그 다시보기로 열거나 이동시키고
  // 전달하는 것까지만 한다.
  if (request.action === 'vodBatch:start') {
    (async () => {
      const videoId = String(request.videoId);
      const skipFileOrders = Array.isArray(request.skipFileOrders) ? request.skipFileOrders.map(Number) : [];
      await setVodBatchRequest({ requesterTabId: sender.tab?.id ?? null, videoId });
      sendResponse({ success: true });

      const tabId = await ensureTabAt(getPlayerTabId, setPlayerTabId, `${VOD_PLAYER_URL_PREFIX}${videoId}`, {
        navigateIfExists: true,
      });
      await sendWithRetry(tabId, { action: 'vodBatch:begin', videoId, skipFileOrders });
    })();
    return true;
  }

  // vodFileInfo.js가 로컬 단계(다운로드 + Studio 업로드 요청 제출)를 끝냈다 — Studio의 실제
  // 전송 확인은 기다리지 않고 바로 완료로 친다. 실패 파일이 있으면 기록/알림을 남기고,
  // 이 배치를 요청했던 vodList.js 탭에 결과를 그대로 전달한다.
  if (request.action === 'vodBatch:complete') {
    (async () => {
      const failOrders = Array.isArray(request.failOrders) ? request.failOrders : [];
      for (const failure of failOrders) {
        recordPipelineFailure({
          videoId: request.videoId,
          fileOrder: Number(failure.fileOrder),
          reason: failure.reason || '알 수 없는 오류',
        });
      }
      const batchRequest = await getVodBatchRequest();
      if (batchRequest?.requesterTabId != null) {
        sendToTab(
          batchRequest.requesterTabId,
          {
            action: 'vodBatch:complete',
            videoId: request.videoId,
            successOrders: Array.isArray(request.successOrders) ? request.successOrders : [],
            failOrders,
            cancelled: Boolean(request.cancelled),
          },
          2000
        );
      }
      await setVodBatchRequest(null);
      sendResponse({ success: true });
    })();
    return true;
  }

  // vodList.js의 "중단" — 지금 플레이어 탭이 돌리고 있는 배치를 즉시 멈춘다(이미 시작된
  // 파일의 다운로드/업로드는 그대로 끝까지 둔다 — 기존 "배치 중단" 버튼과 같은 정책).
  if (request.action === 'vodBatch:cancel') {
    (async () => {
      const tabId = await getPlayerTabId();
      if (tabId != null) sendToTab(tabId, { action: 'vodBatch:cancelCurrent' }, 2000);
      sendResponse({ success: true });
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

  if (request.action === 'download:findExisting') {
    (async () => {
      try {
        const key = `${request.videoId}:${Number(request.fileOrder)}`;
        const { downloadedFiles = {} } = await chrome.storage.local.get(['downloadedFiles']);
        const record = downloadedFiles[key];
        if (!record || record.deletedAt) {
          sendResponse({ success: true, exists: false });
          return;
        }
        // 기록만 믿지 않고 실제로 디스크에 남아 있는지 확인한다(search 호출 자체가 Chrome의
        // exists 재확인을 트리거함) — 사용자가 탐색기 등에서 직접 지웠으면 "이미 있음"으로
        // 잘못 판단해 재다운로드를 건너뛰면 안 된다.
        const items = record.downloadId != null ? await chrome.downloads.search({ id: record.downloadId }) : [];
        const item = items[0];
        if (!item || item.state !== 'complete' || item.exists === false) {
          sendResponse({ success: true, exists: false });
          return;
        }
        sendResponse({ success: true, exists: true, name: record.name });
      } catch (error) {
        sendResponse({ success: true, exists: false });
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

  if (request.action === 'balloon:syncRecent' || request.action === 'balloon:syncYear') {
    (async () => {
      try {
        const result =
          request.action === 'balloon:syncRecent'
            ? await syncBalloonRecent()
            : await syncBalloonPurchasesOfYear(Number(request.year));
        console.log('[balloon] 동기화 결과', result);
        sendResponse({ success: true, result });
      } catch (error) {
        console.error('[balloon] 동기화 실패:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  return false;
});
