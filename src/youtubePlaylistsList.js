// Studio의 재생목록 목록 페이지(studio.youtube.com/channel/{channelId}/content/playlists)에서 내
// 재생목록 전체(이름 + id)를 가져온다. playlistSorter.js가 재생목록 URL을 직접 입력하는 대신
// 드롭다운으로 고를 수 있게 하려는 용도 — 이름을 여기서 바로 얻으므로, 예전처럼 공개
// youtube.com/playlist 페이지에서 제목만 따로 가져오는 단계가 더 이상 필요 없다.
//
// 페이지네이션/페이지당 개수 컨트롤은 영상 목록 테이블(youtubePlaylistVideos.js)과 같은 Studio
// 테이블 컴포넌트를 쓰는 것으로 보여 그 로직을 그대로 재사용한다(셀렉터는 실제 outerHTML
// (2026-10-10)을 보고 작성). 행: ytcp-playlist-row, 이름+id: a#playlist-title-link
// [href="/playlist/{id}/edit"].
(() => {
  const LOG_TAG = '[YtPlaylistsList]';
  const CONFIRM_GAP_MS = 400;
  const POLL_INTERVAL_MS = 300;
  const MAX_PAGES = 50;
  const TARGET_PAGE_SIZE = '50';

  const ROW_SELECTOR = 'ytcp-playlist-row';
  const ROW_LINK_SELECTOR = 'a#playlist-title-link';
  const PAGE_SIZE_TRIGGER_SELECTOR = 'ytcp-table-footer ytcp-dropdown-trigger';
  const PAGE_SIZE_LISTBOX_SELECTOR = 'tp-yt-paper-listbox#paper-list';
  const NEXT_PAGE_BUTTON_SELECTOR = 'ytcp-icon-button#navigate-after';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function confirmFound(getter) {
    const first = getter();
    if (!first) return null;
    await sleep(CONFIRM_GAP_MS);
    return getter() || null;
  }

  async function waitForStable(getter, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await confirmFound(getter);
      if (found) return found;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  function findRows() {
    const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
    return rows.length > 0 ? rows : null;
  }

  function rowPlaylist(row) {
    const a = row.querySelector(ROW_LINK_SELECTOR);
    const href = a?.getAttribute('href') || '';
    const m = /\/playlist\/([A-Za-z0-9_-]+)\/edit/.exec(href);
    if (!m) return null;
    return { id: m[1], title: (a.textContent || '').trim() };
  }

  function collectFromCurrentPage() {
    return (findRows() || []).map(rowPlaylist).filter(Boolean);
  }

  function pageSizeTriggerText() {
    return document.querySelector(PAGE_SIZE_TRIGGER_SELECTOR)?.querySelector('.dropdown-trigger-text')?.textContent?.trim();
  }

  function isNextPageDisabled(button) {
    return !button || button.getAttribute('aria-disabled') === 'true';
  }

  // youtubePlaylistVideos.js의 ensurePageSize50/waitForRowsReloaded와 같은 로직(재생목록
  // 개수가 적어 테이블 자체가 없을 수도 있어 그 경우는 조용히 건너뜀) — 50개로 바뀐 직후
  // 테이블이 옛 페이지 크기 목록을 잠깐 그대로 보여주는 문제를 거기서 실제로 겪었어서 그대로 가져왔다.
  async function ensurePageSize50() {
    const trigger = await waitForStable(() => document.querySelector(PAGE_SIZE_TRIGGER_SELECTOR), 10000);
    if (!trigger) return;
    if (pageSizeTriggerText() === TARGET_PAGE_SIZE) return;

    const countBefore = (findRows() || []).length;
    const mustGrow = !isNextPageDisabled(document.querySelector(NEXT_PAGE_BUTTON_SELECTOR));

    trigger.click();
    const listbox = await waitForStable(() => document.querySelector(PAGE_SIZE_LISTBOX_SELECTOR), 5000);
    if (!listbox) return;
    const option = listbox.querySelector(`tp-yt-paper-item[test-id="${TARGET_PAGE_SIZE}"]`);
    if (!option) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
      );
      return;
    }
    option.click();
    await waitForStable(() => (pageSizeTriggerText() === TARGET_PAGE_SIZE ? true : null), 5000);
    await waitForRowsReloaded(countBefore, mustGrow, 10000);
  }

  async function waitForRowsReloaded(countBefore, mustGrow, timeoutMs) {
    const start = Date.now();
    let lastCount = -1;
    let stableRounds = 0;
    while (Date.now() - start < timeoutMs) {
      const count = (findRows() || []).length;
      const growthOk = !mustGrow || count !== countBefore;
      if (count === lastCount && count > 0 && growthOk) {
        stableRounds += 1;
        if (stableRounds >= 3) return count;
      } else {
        stableRounds = 0;
      }
      lastCount = count;
      await sleep(POLL_INTERVAL_MS);
    }
    return lastCount;
  }

  /** 반환값: { playlists, complete }. complete가 false면 마지막 페이지까지 확실히 도달하지
   *  못하고 중간에 멈춘 것(MAX_PAGES 초과나 다음 페이지 전환 확인 실패). */
  async function fetchAllPlaylists() {
    const hasRows = await waitForStable(findRows, 15000);
    if (!hasRows) return { playlists: [], complete: true }; // 재생목록이 하나도 없는 경우

    await ensurePageSize50();

    const playlists = [];
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pagePlaylists = collectFromCurrentPage();
      playlists.push(...pagePlaylists);
      console.log(`${LOG_TAG} ${page + 1}페이지: ${pagePlaylists.length}개 (누적 ${playlists.length}개)`);

      const nextBtn = document.querySelector(NEXT_PAGE_BUTTON_SELECTOR);
      if (isNextPageDisabled(nextBtn)) {
        complete = true;
        break;
      }

      // youtubePlaylistVideos.js와 같은 이유로 첫 행이 아니라 페이지 전체의 id 집합을 비교한다.
      const idsBefore = pagePlaylists.map((p) => p.id).join(',');
      nextBtn.click();
      const changed = await waitForStable(() => {
        const rows = findRows();
        if (!rows) return null;
        const idsNow = rows.map(rowPlaylist).filter(Boolean).map((p) => p.id).join(',');
        return idsNow && idsNow !== idsBefore ? rows : null;
      }, 10000);
      if (!changed) {
        console.warn(`${LOG_TAG} 다음 페이지로 넘어갔는지 확인 못함 — 중단 (지금까지 ${playlists.length}개)`);
        break;
      }
    }
    return { playlists, complete };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== 'ytPlaylists:fetchAll') return false;
    fetchAllPlaylists().then(
      ({ playlists, complete }) => sendResponse({ success: true, playlists, complete }),
      (error) => {
        console.error(`${LOG_TAG} 조회 오류:`, error);
        sendResponse({ success: false, error: error.message });
      }
    );
    return true;
  });

  console.log(`${LOG_TAG} 준비됨 (${location.href})`);
})();
