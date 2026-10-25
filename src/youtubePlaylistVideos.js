// Studio의 재생목록 "동영상" 탭(studio.youtube.com/playlist/<id>/videos)에서 전체 videoId를
// 가져온다. 공개 재생목록 페이지(youtubePlaylistAdd.js)와 달리 전세계 차단된 영상도 다 보여주므로
// 이게 "이미 있는지" 판정의 진짜 기준이다(공개 페이지에서 그 영상들이 통째로 빠져서 생기는
// 누락 버그가 실제로 있었음).
//
// 이 페이지는 가상 스크롤이 아니라 페이지네이션이라, 공개 페이지처럼 스크롤 추측을 할 필요가
// 없다 — 페이지당 개수를 50으로 올리고 "다음 페이지" 버튼을 끝까지 누르면 되고, 그 버튼의
// aria-disabled로 마지막 페이지를 확실히 알 수 있다.
//
// 셀렉터는 실제 outerHTML(2026-10-08)을 보고 작성했다:
//   행: ytcp-video-row > ... a#video-title[href="/video/{videoId}/edit"]
//   페이지당 개수 트리거: ytcp-table-footer 안의 ytcp-dropdown-trigger (.dropdown-trigger-text)
//   페이지당 개수 목록: tp-yt-paper-listbox#paper-list > tp-yt-paper-item[test-id="50"]
//   다음 페이지: ytcp-icon-button#navigate-after (aria-disabled="true"면 마지막 페이지)
(() => {
  const LOG_TAG = '[YtPlaylistVideos]';
  const CONFIRM_GAP_MS = 400;
  const POLL_INTERVAL_MS = 300;
  const MAX_PAGES = 300; // 50개씩 300페이지 = 15,000개. 안전장치일 뿐 보통 훨씬 적게 끝난다.
  const TARGET_PAGE_SIZE = '50';

  const ROW_SELECTOR = 'ytcp-video-row';
  const ROW_LINK_SELECTOR = 'a#video-title';
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

  function rowVideoId(row) {
    const href = row.querySelector(ROW_LINK_SELECTOR)?.getAttribute('href') || '';
    return /\/video\/([A-Za-z0-9_-]{11})\/edit/.exec(href)?.[1] || null;
  }

  function collectVideoIdsFromCurrentPage() {
    return (findRows() || []).map(rowVideoId).filter(Boolean);
  }

  function pageSizeTriggerText() {
    return document.querySelector(PAGE_SIZE_TRIGGER_SELECTOR)?.querySelector('.dropdown-trigger-text')?.textContent?.trim();
  }

  async function ensurePageSize50() {
    const trigger = await waitForStable(() => document.querySelector(PAGE_SIZE_TRIGGER_SELECTOR), 10000);
    if (!trigger) {
      console.warn(`${LOG_TAG} 페이지당 개수 선택 컨트롤을 찾지 못함 — 기본값으로 진행`);
      return;
    }
    if (pageSizeTriggerText() === TARGET_PAGE_SIZE) return;

    const countBefore = (findRows() || []).length;
    // 전에 더 불러올 페이지가 있었다면(다음 페이지 버튼이 눌릴 수 있었다면), 50개로 바꾼 뒤엔
    // 반드시 행 개수가 늘어나야 한다 — 그렇지 않으면 아직 옛 페이지 크기의 목록을 보고 있는
    // 것으로 간주한다(아래 waitForRowsReloaded).
    const mustGrow = !isNextPageDisabled(document.querySelector(NEXT_PAGE_BUTTON_SELECTOR));

    trigger.click();
    const listbox = await waitForStable(() => document.querySelector(PAGE_SIZE_LISTBOX_SELECTOR), 5000);
    if (!listbox) {
      console.warn(`${LOG_TAG} 페이지당 개수 목록을 못 찾음 — 기본값으로 진행`);
      return;
    }
    const option = listbox.querySelector(`tp-yt-paper-item[test-id="${TARGET_PAGE_SIZE}"]`);
    if (!option) {
      console.warn(`${LOG_TAG} "${TARGET_PAGE_SIZE}" 옵션을 못 찾음 — 기본값으로 진행`);
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
      );
      return;
    }
    option.click();
    await waitForStable(() => (pageSizeTriggerText() === TARGET_PAGE_SIZE ? true : null), 5000);
    // 트리거 글자는 바로 바뀌어도 테이블은 옛 목록(예: 30개)을 잠깐 그대로 보여주며 새로고침하는
    // 경우가 실제로 있었다 — "행이 있다"고만 확인하면 그 옛 목록을 50개 전체인 줄 알고 끝내버린다.
    // 그래서 행 개수가 (더 불러올 게 있었다면) 실제로 달라지고, 그 상태로 잠깐 안정될 때까지 기다린다.
    const countAfter = await waitForRowsReloaded(countBefore, mustGrow, 10000);
    console.log(`${LOG_TAG} 페이지당 개수를 ${TARGET_PAGE_SIZE}로 설정 (행 ${countBefore}개 → ${countAfter}개)`);
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
    console.warn(`${LOG_TAG} 50개 전환 후 행 개수 안정 확인 실패(제한시간) — 지금 보이는 ${lastCount}개로 진행`);
    return lastCount;
  }

  function isNextPageDisabled(button) {
    return !button || button.getAttribute('aria-disabled') === 'true';
  }

  /** 반환값: { videoIds, complete }. complete가 false면 마지막 페이지(aria-disabled)까지
   *  확실히 도달하지 못하고 중간에 멈춘 것 — MAX_PAGES 초과나 다음 페이지 전환 확인 실패. */
  async function fetchAllVideoIds() {
    await waitForStable(findRows, 15000); // 빈 재생목록이면 그냥 타임아웃되고 아래서 0개로 진행
    await ensurePageSize50();

    const videoIds = [];
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageIds = collectVideoIdsFromCurrentPage();
      videoIds.push(...pageIds);
      console.log(`${LOG_TAG} ${page + 1}페이지: ${pageIds.length}개 (누적 ${videoIds.length}개)`);

      const nextBtn = document.querySelector(NEXT_PAGE_BUTTON_SELECTOR);
      if (isNextPageDisabled(nextBtn)) {
        console.log(`${LOG_TAG} 마지막 페이지 도달 — 총 ${videoIds.length}개`);
        complete = true;
        break;
      }

      // 첫 행만 보고 "넘어갔는지" 판단하면, 다음 페이지의 첫 행이 삭제/비공개 영상처럼
      // a#video-title이 없는 특이한 행일 때 videoId를 못 읽어 영원히 "안 넘어감"으로 오판하고
      // 멈추는 버그가 있었다(실제 재현됨) — 페이지 전체의 id 집합을 비교해 그런 행 하나 때문에
      // 전체가 막히지 않게 한다.
      const idsBefore = pageIds.join(',');
      nextBtn.click();
      const changed = await waitForStable(() => {
        const rows = findRows();
        if (!rows) return null;
        const idsNow = rows.map(rowVideoId).filter(Boolean).join(',');
        return idsNow && idsNow !== idsBefore ? rows : null;
      }, 10000);
      if (!changed) {
        const stuckIds = (findRows() || []).map(rowVideoId);
        console.warn(
          `${LOG_TAG} 다음 페이지로 넘어갔는지 확인 못함 — 중단 (지금까지 ${videoIds.length}개). 이전 페이지:`,
          pageIds,
          '지금 보이는 행:',
          stuckIds
        );
        break;
      }
    }
    if (!complete) console.warn(`${LOG_TAG} 전체를 다 못 불러왔을 수 있음 (MAX_PAGES 도달 또는 중단)`);
    return { videoIds, complete };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== 'ytPlaylistVideos:fetchAll') return false;
    fetchAllVideoIds().then(
      ({ videoIds, complete }) => sendResponse({ success: true, videoIds, complete }),
      (error) => {
        console.error(`${LOG_TAG} 조회 오류:`, error);
        sendResponse({ success: false, error: error.message });
      }
    );
    return true;
  });

  console.log(`${LOG_TAG} 준비됨 (${location.href})`);
})();
