/**
 * Content Script: 방송국 다시보기 목록 페이지(www.sooplive.com/station/{bjId}/vod...)에서
 * 각 다시보기가 유튜브에 올라갔는지 판별해 보여준다. 판별 근거는 내 채널의 실제 업로드 영상:
 * 설명의 Soop 다시보기 링크로 어느 다시보기인지, 제목의 "[날짜 (n/max)]"로 몇 번째 파일인지 맞춘다
 * (매칭 규칙은 youtubeMatch.js). 파일이 하나라도 안 올라갔으면 그 다시보기는 미업로드로 본다.
 * 이후 각 다시보기를 순서대로 업로드하는 자동화가 이 결과(window 이벤트/콘솔)를 이어받는다.
 */

(() => {
  const LOG_TAG = '[VodList]';
  const HOST_ID = 'private-extension-vod-list-host';

  if (!/^\/station\/[^/]+\/vod(\/|$)/.test(location.pathname)) return;

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.vodFileInfo?.enabled === false) return;
    mountButton();
  });

  /** 현재 DOM에 렌더된 다시보기 링크(…/player/{id})에서 중복 없이 아이디를 순서대로 모은다. */
  function collectVideoIds() {
    const ids = [];
    for (const a of document.querySelectorAll('a[href*="/player/"]')) {
      const m = a.href.match(/\/player\/(\d+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  }

  function mountButton() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        button{padding:8px 12px;border:0;border-radius:6px;background:#3b5bdb;color:#fff;cursor:pointer}
        button:disabled{opacity:.6;cursor:default}
        pre{margin:6px 0 0;max-width:420px;max-height:320px;overflow:auto;padding:8px;background:#fff;
            color:#222;border:1px solid #ccc;border-radius:6px;white-space:pre-wrap;user-select:text}
      </style>
      <button>유튜브 업로드 여부 확인</button><pre hidden></pre>`;
    const button = shadow.querySelector('button');
    const out = shadow.querySelector('pre');
    button.addEventListener('click', async () => {
      button.disabled = true;
      out.hidden = false;
      out.textContent = '유튜브 영상 목록을 가져오는 중... (Studio 탭을 잠깐 열 수 있습니다)';
      try {
        out.textContent = await run();
      } catch (error) {
        out.textContent = `실패: ${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
    document.body.appendChild(host);
  }

  function formatVod(vod) {
    if (vod.error) return `${vod.videoId}  (${vod.error})`;
    const head = `${vod.videoId}  ${vod.complete ? '업로드 완료' : '미업로드/일부 미업로드'}`;
    const files = vod.files.map((f) => {
      const label = `  (${f.n}/${vod.fileCount})`;
      if (!f.uploaded) return `${label} ✗ 미업로드`;
      const notes = [f.privacy, f.duplicates ? `중복 ${f.duplicates}개` : '', f.maxMismatch ? '제목의 max 불일치' : '']
        .filter(Boolean)
        .join(', ');
      return `${label} ✓ ${f.youtubeUrl}${notes ? ` [${notes}]` : ''}`;
    });
    return [head, ...files].join('\n');
  }

  async function run() {
    const videoIds = collectVideoIds();
    if (videoIds.length === 0) return '이 페이지에서 다시보기 링크를 찾지 못했습니다.';

    const res = await chrome.runtime.sendMessage({ action: 'vodUpload:match', videoIds });
    if (!res?.success) throw new Error(res?.error || '판별 실패');

    const pending = res.vods.filter((v) => !v.error && !v.complete);
    const uploaded = res.vods.filter((v) => !v.error && v.complete);
    console.log(`${LOG_TAG} 미업로드 ${pending.length} / 업로드 완료 ${uploaded.length} / 전체 ${videoIds.length}`, {
      pendingIds: pending.map((v) => v.videoId),
      vods: res.vods,
    });
    // 업로드 자동화가 붙을 지점
    window.dispatchEvent(new CustomEvent('private-extension:vod-match', { detail: { pending, uploaded, all: res.vods } }));

    return [
      `유튜브 영상 ${res.youtubeVideoCount}개 조회 · 다시보기 ${videoIds.length}개 중 미업로드 ${pending.length}개`,
      '',
      '[미업로드 아이디]',
      pending.map((v) => v.videoId).join('\n') || '(없음)',
      '',
      '[상세]',
      ...res.vods.map(formatVod),
    ].join('\n');
  }
})();
