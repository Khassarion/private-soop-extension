/**
 * Content Script (studio.youtube.com): 내 채널에 올린 영상 목록(제목·설명·공개범위)을
 * background에 넘겨준다. Studio 자신의 내부 API(creator/list_creator_videos)를 같은 origin에서
 * 호출하므로 로그인 쿠키만으로 동작하고, 별도 OAuth/API 키가 필요 없다.
 * 이 API의 요청/응답 형식은 문서화돼 있지 않아 기억에 의존해 작성했다 — 실패하면 응답 본문 일부를
 * 에러에 담아 돌려주니, 형식이 바뀌었다면 Studio의 네트워크 탭에서 같은 요청을 보고 맞춰야 한다.
 */

(() => {
  const LOG_TAG = '[YoutubeVideos]';
  const PAGE_SIZE = 30;
  const MAX_PAGES = 200;
  const FALLBACK_CLIENT_VERSION = '1.20250101.00.00';

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== 'youtubeVideos:list') return false;
    listAllVideos().then(
      (videos) => sendResponse({ success: true, videos }),
      (error) => sendResponse({ success: false, error: error.message })
    );
    return true;
  });

  function pageConfig(name) {
    const m = document.documentElement.innerHTML.match(new RegExp(`"${name}":"([^"]+)"`));
    return m ? m[1] : null;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? m[1] : null;
  }

  async function sapisidHash() {
    const sid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sid) throw new Error('유튜브 로그인 쿠키(SAPISID)를 찾지 못했습니다. Studio에 로그인돼 있나요?');
    const ts = Math.floor(Date.now() / 1000);
    const data = new TextEncoder().encode(`${ts} ${sid} ${location.origin}`);
    const digest = await crypto.subtle.digest('SHA-1', data);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function listAllVideos() {
    const channelId = location.pathname.match(/\/channel\/(UC[\w-]+)/)?.[1];
    if (!channelId) throw new Error('NO_CHANNEL: Studio 채널 페이지가 아직 열리지 않았습니다.');

    const key = pageConfig('INNERTUBE_API_KEY');
    const url = `/youtubei/v1/creator/list_creator_videos?alt=json${key ? `&key=${key}` : ''}`;
    const context = {
      client: {
        clientName: 62,
        clientVersion: pageConfig('INNERTUBE_CONTEXT_CLIENT_VERSION') || FALLBACK_CLIENT_VERSION,
        hl: 'ko',
        gl: 'KR',
      },
    };

    const videos = [];
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          authorization: await sapisidHash(),
          'x-origin': location.origin,
          'x-goog-authuser': '0',
        },
        body: JSON.stringify({
          context,
          filter: {
            and: {
              operands: [
                { channelIdIs: { value: channelId } },
                { videoOriginIs: { value: 'VIDEO_ORIGIN_UPLOAD' } },
              ],
            },
          },
          order: 'VIDEO_ORDER_DISPLAY_TIME_DESC',
          pageSize: PAGE_SIZE,
          pageToken,
          mask: { videoId: true, title: true, description: true, privacy: true },
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`영상 목록 요청 실패 (${res.status}): ${text.slice(0, 200)}`);
      let body;
      try {
        body = JSON.parse(text);
      } catch (_e) {
        throw new Error(`영상 목록 응답을 해석하지 못했습니다: ${text.slice(0, 200)}`);
      }

      for (const v of body.videos || []) {
        videos.push({ videoId: v.videoId, title: v.title || '', description: v.description || '', privacy: v.privacy || '' });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    console.log(`${LOG_TAG} 영상 ${videos.length}개 조회`);
    return videos;
  }
})();
