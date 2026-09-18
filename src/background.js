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
 * 유튜브 업로드용 OAuth 액세스 토큰을 가져옵니다. chrome.identity는 extension
 * 컨텍스트(background)에서만 접근 가능해 content script를 대신해 여기서 처리한다.
 * @param {boolean} interactive true면 필요 시 로그인/동의 팝업을 띄운다.
 * @returns {Promise<string>}
 */
function getYoutubeAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || '인증 토큰을 가져오지 못했습니다.'));
        return;
      }
      resolve(token);
    });
  });
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

  if (request.action === 'youtubePlaylists:fetch') {
    (async () => {
      try {
        let token = await getYoutubeAuthToken(true);
        let playlists;
        try {
          playlists = await listMyPlaylists(token);
        } catch (error) {
          if (error.status === 401) {
            await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
            token = await getYoutubeAuthToken(true);
            playlists = await listMyPlaylists(token);
          } else {
            throw error;
          }
        }
        sendResponse({ success: true, playlists });
      } catch (error) {
        console.error('[youtubeUpload] 재생목록 목록 조회 오류:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'download:start') {
    (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: request.url,
          filename: request.filename,
        });
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

/**
 * 유튜브 업로드 전용 포트.
 * 실제 네트워크 요청(토큰 발급 포함)은 여기 background에서만 수행한다 — content
 * script의 fetch/XHR은 host_permissions가 있어도 페이지 출처 기준 CORS 제약을
 * 그대로 받기 때문에(확장 컨텍스트만 CORS-free), googleapis.com 업로드는 반드시
 * background에서 처리해야 한다.
 *
 * File/Blob 객체 자체는 chrome.runtime 메시징으로 넘기지 않는다 — Blob은 구조화된
 * 복제 대상이 아니어서(넘기면 size/stream 등이 비어버려 "Content-Range" 파싱 오류가
 * 났었다) content script가 파일을 청크(ArrayBuffer, 8MiB)로 잘라 순서대로 보내고,
 * background는 청크 하나를 성공적으로 PUT할 때마다 'chunkAck'로 다음 청크를 요청하는
 * 방식으로 흐름을 제어한다.
 */
const YOUTUBE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'youtubeUpload') return;

  const session = {
    token: null,
    sessionUrl: null,
    totalSize: 0,
    fileType: 'video/mp4',
    playlistId: null,
  };

  port.onMessage.addListener((message) => {
    if (message?.type === 'start') {
      handleUploadStart(port, session, message).catch((error) => {
        safePortPost(port, { type: 'error', message: error.message });
      });
    } else if (message?.type === 'chunk') {
      handleUploadChunk(port, session, message).catch((error) => {
        safePortPost(port, { type: 'error', message: error.message });
      });
    }
  });
});

function safePortPost(port, message) {
  try {
    port.postMessage(message);
  } catch (error) {
    // 탭이 닫히는 등으로 포트가 이미 끊어진 경우 - 무시
  }
}

async function handleUploadStart(port, session, { title, description, privacy, playlistId, fileName, fileType, fileSize }) {
  const snippet = { title, description };
  const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false };

  session.totalSize = fileSize;
  session.fileType = fileType || 'video/mp4';
  session.playlistId = playlistId || null;

  session.token = await getYoutubeAuthToken(true);
  try {
    session.sessionUrl = await initiateResumableUpload(session.token, session.fileType, fileSize, snippet, status);
  } catch (error) {
    if (error.status === 401) {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: session.token }, resolve));
      session.token = await getYoutubeAuthToken(true);
      session.sessionUrl = await initiateResumableUpload(session.token, session.fileType, fileSize, snippet, status);
    } else {
      throw error;
    }
  }

  safePortPost(port, { type: 'ready' });
}

/**
 * base64 문자열을 바이트 배열로 되돌린다. chrome.runtime 메시징이 ArrayBuffer를
 * JSON으로 직렬화하면서 유실시키는 문제를 피하기 위해 content script가 base64로
 * 인코딩해서 보낸 청크를 여기서 원래 바이트로 복원한다.
 */
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function handleUploadChunk(port, session, { data, start, end, isLast }, retryCount = 0) {
  let res;
  try {
    const bytes = base64ToUint8Array(data);
    const headers = { 'Content-Type': session.fileType };
    headers['Content-Range'] = `bytes ${start}-${end - 1}/${session.totalSize}`;
    res = await fetch(session.sessionUrl, { method: 'PUT', headers, body: bytes });
  } catch (networkError) {
    if (retryCount < 1) {
      return handleUploadChunk(port, session, { data, start, end, isLast }, retryCount + 1);
    }
    throw new Error('네트워크 오류로 업로드에 실패했습니다.');
  }

  if (isLast) {
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('[youtubeUpload] 업로드 마지막 청크 실패:', res.status, bodyText);
      throw new Error(`업로드 실패 (${res.status}): ${bodyText.slice(0, 300)}`);
    }
    const video = await res.json();

    let playlistError = null;
    if (session.playlistId) {
      try {
        await addVideoToPlaylist(session.token, session.playlistId, video.id);
      } catch (error) {
        playlistError = error.message;
      }
    }

    safePortPost(port, { type: 'done', video, playlistError });
    return;
  }

  if (res.status !== 308 && !res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('[youtubeUpload] 업로드 청크 실패:', res.status, bodyText);
    throw new Error(`업로드 실패 (${res.status}): ${bodyText.slice(0, 300)}`);
  }

  safePortPost(port, { type: 'progress', ratio: end / session.totalSize });
  safePortPost(port, { type: 'chunkAck' });
}

/**
 * 업로드된 영상을 재생목록에 추가한다. 실패해도 업로드 자체는 이미 완료된 상태이므로
 * 호출부에서 별도로 처리(치명적 오류로 취급하지 않음).
 * @param {string} token
 * @param {string} playlistId
 * @param {string} videoId
 */
async function addVideoToPlaylist(token, playlistId, videoId) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId },
      },
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('[youtubeUpload] 재생목록 추가 실패:', res.status, bodyText);
    throw new Error(`재생목록 추가 실패 (${res.status}): ${bodyText.slice(0, 300)}`);
  }
}

/**
 * 로그인한 계정의 재생목록 목록을 전부 가져온다 (페이지네이션 처리).
 * @param {string} token
 * @returns {Promise<{id: string, title: string}[]>}
 */
async function listMyPlaylists(token) {
  const playlists = [];
  let pageToken = '';

  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlists');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const error = new Error(`재생목록 목록 조회 실패 (${res.status}): ${bodyText.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    for (const item of data.items || []) {
      playlists.push({ id: item.id, title: item.snippet?.title || '(제목 없음)' });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return playlists;
}

/**
 * @param {string} token OAuth 액세스 토큰
 * @param {string} fileType
 * @param {number} fileSize
 * @param {object} snippet
 * @param {object} status
 * @returns {Promise<string>} 업로드 세션 URL
 */
async function initiateResumableUpload(token, fileType, fileSize, snippet, status) {
  const res = await fetch(`${YOUTUBE_UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': fileType || 'video/mp4',
      'X-Upload-Content-Length': String(fileSize),
    },
    body: JSON.stringify({ snippet, status }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const error = new Error(`업로드 세션 생성 실패 (${res.status}): ${bodyText.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const sessionUrl = res.headers.get('Location');
  if (!sessionUrl) throw new Error('업로드 세션 URL을 받지 못했습니다.');
  return sessionUrl;
}
