/**
 * Soop(sooplive.com) 라이브 방송 상태 조회 모듈
 * ../VOD-Master/src/.test/soop_api_standalone.js 의 SoopAPI.GetChannelBroad를 최소 이식한 버전.
 * background service worker(ES module)에서만 사용한다 (cross-origin fetch를 여기서 전담).
 */

const API_CHANNEL_ORIGIN = 'https://api-channel.sooplive.com';

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
