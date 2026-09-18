/**
 * Soop(sooplive.com) API 호출 모듈
 * ../VOD-Master/src/.test/soop_api_standalone.js 의 SoopAPI에서 필요한 부분만 최소 이식한 버전.
 * background service worker(ES module)에서만 사용한다 (cross-origin fetch를 여기서 전담).
 */

const API_CHANNEL_ORIGIN = 'https://api-channel.sooplive.com';
const AFEVENT2_ORIGIN = 'https://afevent2.sooplive.com';
const TKAPI_ORIGIN = 'https://tkapi.sooplive.com';
const API_M_ORIGIN = 'https://api.m.sooplive.com';
const VOD_ORIGIN = 'https://vod.sooplive.com';

/**
 * 스트리머 라이브 방송 정보 조회. 방송 중이 아니면 null.
 * @param {string} streamerId 스트리머 userId (예: chebi2)
 * @returns {Promise<object|null>} broadNo·broadTitle 등, 오프라인이면 null
 */
export async function getChannelBroad(streamerId) {
  if (!streamerId) return null;
  const url = `${API_CHANNEL_ORIGIN}/v1.1/channel/${encodeURIComponent(String(streamerId))}/home/section/broad`;

  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
    },
    method: 'GET',
    mode: 'cors',
    credentials: 'include',
  });
  if (res.status !== 200) return null;

  const text = await res.text();
  if (!text || !text.trim()) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    return null;
  }

  if (!data || typeof data !== 'object' || data.broadNo == null) return null;
  return data;
}

/**
 * @param {string} streamerId
 * @returns {Promise<boolean>} 현재 라이브 방송 중인지 여부
 */
export async function isStreamerLive(streamerId) {
  try {
    const broad = await getChannelBroad(streamerId);
    return broad !== null;
  } catch (error) {
    console.error('[soopLiveApi] isStreamerLive 오류:', streamerId, error);
    return false;
  }
}

/**
 * 로그인한 사용자 정보 조회 (loginId 획득용).
 * @returns {Promise<object|null>}
 */
export async function getPrivateInfo() {
  const url = `${AFEVENT2_ORIGIN}/api/get_private_info.php?_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
    },
    method: 'GET',
    mode: 'cors',
    credentials: 'include',
  });
  if (res.status !== 200) return null;
  return res.json();
}

/**
 * @returns {Promise<string|null>} 현재 로그인된 계정의 loginId, 로그인되어 있지 않으면 null
 */
export async function getLoginId() {
  try {
    const info = await getPrivateInfo();
    return info?.CHANNEL?.LOGIN_ID ?? null;
  } catch (error) {
    console.error('[soopLiveApi] getLoginId 오류:', error);
    return null;
  }
}

/**
 * 일일 포인트 미션 현황 조회 (mypoint.sooplive.com의 "포인트 상세내역"과 동일한 데이터).
 * @param {string} loginId
 * @param {string} startDate YYYY-MM-DD
 * @returns {Promise<object|null>} 카테고리별 DATA 객체, 실패 시 null
 */
export async function getMissionStatus(loginId, startDate) {
  if (!loginId) return null;
  const url = `${TKAPI_ORIGIN}/history/${encodeURIComponent(loginId)}/mission/?start_date=${encodeURIComponent(startDate)}`;

  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
    },
    method: 'GET',
    mode: 'cors',
    credentials: 'include',
  });
  if (res.status !== 200) return null;

  const body = await res.json();
  if (!body || body.RESULT !== 1 || !body.DATA) return null;
  return body.DATA;
}

/**
 * VOD 상세 정보 조회 (files 배열 - 각 file의 file_start/duration/chat 등 포함).
 * @param {string|number} videoId titleNo (vod.sooplive.com/player/{titleNo})
 * @returns {Promise<object|null>} data 객체 (files, write_tm, total_file_duration, bj_id 등), 실패 시 null
 */
export async function getSoopVodInfo(videoId) {
  if (!videoId) return null;
  const referer = `${VOD_ORIGIN}/player/${videoId}`;

  const res = await fetch(`${API_M_ORIGIN}/station/video/a/view`, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
      Referer: referer,
    },
    body: `nTitleNo=${encodeURIComponent(videoId)}&nApiLevel=11&nPlaylistIdx=0`,
    method: 'POST',
    credentials: 'include',
  });
  if (res.status !== 200) return null;

  const body = await res.json();
  if (!body || body.result !== 1 || !body.data) return null;
  return body.data;
}
