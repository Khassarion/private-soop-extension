// www.youtube.com 시청 페이지(/watch)에서 동작한다: "저장" 버튼 → 재생목록 패널 → 행
// 버튼(토글)을 직접 눌러 영상을 재생목록에 추가한다. YouTube Data API의
// playlistItems.insert(호출당 50쿼터, 하루 ~200건 한도)를 안 쓰기 위한 수단.
// 재생목록 이름·id 목록은 youtubePlaylistsList.js(Studio), 영상 멤버십("이미 있는지")은
// youtubePlaylistVideos.js(Studio)가 맡는다 — 예전엔 이 파일이 공개 www.youtube.com/playlist
// 페이지에서 제목만 따로 가져왔는데, Studio가 이름+id를 한 번에 주게 되면서 그 단계가
// 없어졌다(그 공개 페이지는 전세계 차단 영상을 안 보여줘서 멤버십 판정에도 못 썼던 적이 있다).
// background가 이 탭을 해당 영상 페이지로 이동시킨 뒤 요청을 보낸다
// (background.js의 ensureTabAt/getYtAddTabId 참고).
//
// 셀렉터는 실제 패널의 outerHTML(2026-10-08)을 보고 작성했다. 패널 구조:
//   tp-yt-iron-dropdown > ... > yt-list-view-model[role="menu"] > toggleable-list-item-view-model
//     > yt-list-item-view-model > button.ytListItemViewModelButtonOrAnchor[aria-pressed]
//       (체크박스가 따로 없다 — 이 button 자체가 토글이고, aria-pressed="true"면 이미 추가됨.
//        제목은 그 안의 .ytListItemViewModelTitle)
// 닫기 버튼이 없는 패널이라(헤더의 trailing-buttons가 빈 div) Esc 키 이벤트로 닫는다.
(() => {
  const LOG_TAG = '[YtPlaylistAdd]';
  const CONFIRM_GAP_MS = 500;
  const POLL_INTERVAL_MS = 300;

  const SAVE_BUTTON_SELECTOR = '#flexible-item-buttons > yt-button-view-model > button-view-model > button';
  const ROW_SELECTOR = 'tp-yt-iron-dropdown yt-list-item-view-model';
  const ROW_BUTTON_SELECTOR = 'button.ytListItemViewModelButtonOrAnchor';
  const ROW_TITLE_SELECTOR = '.ytListItemViewModelTitle';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 한 번 보이고 CONFIRM_GAP_MS 뒤에도 여전히 있어야 진짜로 있다고 본다 — SPA 전환 중
  // 한 프레임만 존재하다 사라지는 엘리먼트를 잘못 클릭하는 사고를 막는다(Studio 자동화와 같은 이유).
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

  // 닫힌 과거 드롭다운이 DOM에서 완전히 지워지지 않고 숨겨진 채로 남는 경우가 있어서(YouTube의
  // 오버레이 컴포넌트가 재사용을 위해 숨겨두는 걸로 보임), 보이는 것만 "진짜 지금 떠있는 패널"로
  // 친다. 안 그러면 숨겨진 옛 사본의 aria-pressed를 읽거나 거기를 클릭해버릴 수 있다.
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findRows() {
    const all = Array.from(document.querySelectorAll(ROW_SELECTOR));
    const rows = all.filter(isVisible);
    if (all.length !== rows.length) {
      console.log(`${LOG_TAG} findRows: 전체 ${all.length}개 중 보이는 것 ${rows.length}개 (나머지는 숨겨진 과거 사본으로 추정)`);
    }
    return rows.length > 0 ? rows : null;
  }

  function rowButton(row) {
    return row.querySelector(ROW_BUTTON_SELECTOR);
  }

  function rowTitle(row) {
    return row.querySelector(ROW_TITLE_SELECTOR)?.textContent?.trim() || '';
  }

  function isPressed(button) {
    return button?.getAttribute('aria-pressed') === 'true';
  }

  function closePopup() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
    );
  }

  async function addToPlaylist({ playlistName }) {
    console.log(`${LOG_TAG} addToPlaylist 시작: "${playlistName}"`);
    const saveBtn = await waitForStable(() => document.querySelector(SAVE_BUTTON_SELECTOR), 15000);
    if (!saveBtn) return { success: false, error: '저장 버튼을 찾지 못함 (영상이 삭제/비공개 상태일 수 있음)' };
    console.log(`${LOG_TAG} 저장 버튼 클릭`);
    saveBtn.click();

    const rows = await waitForStable(findRows, 10000);
    if (!rows) return { success: false, error: '재생목록 패널을 찾지 못함' };

    // 정확한 이름 일치만 — 부분 일치는 다른 이름의 재생목록을 잘못 건드릴 수 있어 쓰지 않는다.
    const matches = rows.filter((row) => rowTitle(row) === playlistName);
    console.log(`${LOG_TAG} 패널에 보이는 행 ${rows.length}개, "${playlistName}" 이름 일치 ${matches.length}개`, {
      모든제목: rows.map(rowTitle),
    });
    if (matches.length > 1) {
      console.warn(`${LOG_TAG} 같은 이름의 재생목록이 ${matches.length}개 보임 — 첫 번째 것을 쓴다(잘못된 쪽일 수 있음)`);
    }
    const target = matches[0];
    if (!target) {
      closePopup();
      return { success: false, error: `재생목록 "${playlistName}"을 패널에서 찾지 못함` };
    }

    const button = rowButton(target);
    if (!button) {
      closePopup();
      return { success: false, error: '재생목록 행의 버튼을 찾지 못함' };
    }

    const alreadyChecked = isPressed(button);
    console.log(`${LOG_TAG} 대상 행 찾음, 클릭 전 aria-pressed=${alreadyChecked}`);
    if (alreadyChecked) {
      closePopup();
      return { success: true, alreadyExisted: true };
    }

    button.click();
    console.log(`${LOG_TAG} 행 버튼 클릭함, 선택 상태 변화 대기 시작`);
    // 선택되면 패널이 스스로 닫히는 경우가 있어서(가지고 있던 button 참조가 DOM에서 떨어져
    // 나가 aria-pressed를 다시 읽어도 소용없음), 클릭 직후부터는 매번 행을 새로 찾는다.
    // 그 행(또는 패널 자체)이 사라졌으면 선택되면서 닫힌 것으로 보고 성공 처리한다 — 에러
    // 토스트 없이 조용히 닫히는 게 실패의 신호는 아니기 때문이다.
    const result = await waitForSelectionResult(playlistName, 3000);
    console.log(`${LOG_TAG} 선택 상태 확인 결과: ${result}`);
    closePopup();
    if (result === 'timeout') return { success: false, error: '클릭했지만 선택 상태로 바뀌지 않음' };
    return { success: true, alreadyExisted: false };
  }

  async function waitForSelectionResult(playlistName, timeoutMs) {
    const start = Date.now();
    let tick = 0;
    while (Date.now() - start < timeoutMs) {
      tick += 1;
      // findRows()는 보이는 것만 돌려주지만(위 isVisible), 숨겨진 과거 사본까지 포함한 전체
      // 개수도 같이 찍어서 "숨겨진 사본 때문에 못 찾는다" 가능성을 구분할 수 있게 한다.
      const allMatchingAnywhere = Array.from(document.querySelectorAll(ROW_SELECTOR)).filter(
        (r) => rowTitle(r) === playlistName
      );
      const rows = findRows();
      if (!rows) {
        console.log(`${LOG_TAG} [${tick}] 패널 자체가 사라짐 (전체 DOM엔 같은 이름 ${allMatchingAnywhere.length}개 남음) → closed`);
        return 'closed';
      }
      const row = rows.find((r) => rowTitle(r) === playlistName);
      if (!row) {
        console.log(`${LOG_TAG} [${tick}] 보이는 패널은 있는데 "${playlistName}" 행이 없음 → closed`);
        return 'closed';
      }
      const pressed = isPressed(rowButton(row));
      console.log(`${LOG_TAG} [${tick}] 행 찾음, aria-pressed=${pressed} (전체 DOM엔 같은 이름 ${allMatchingAnywhere.length}개)`);
      if (pressed) return 'pressed';
      await sleep(POLL_INTERVAL_MS);
    }
    return 'timeout';
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'ytAdd:newRequest') {
      (async () => {
        try {
          const result = await addToPlaylist({ playlistName: request.playlistName });
          sendResponse(result);
        } catch (error) {
          console.error(`${LOG_TAG} 처리 오류:`, error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    return false;
  });

  // 시청 페이지 탭은 background가 자동으로 열고/이동시키는 용도라, 소리가 나며 자동재생되는 걸
  // 막기 위해 영상을 찾는 즉시 일시정지한다. 'play' 리스너를 같이 걸어서 광고 전환 등으로
  // 뒤늦게 다시 재생되려 해도 바로 멈춘다.
  const PAUSE_POLL_INTERVAL_MS = 300;
  const PAUSE_POLL_MAX_MS = 15000;

  function pauseVideoWhenReady() {
    if (!location.pathname.startsWith('/watch')) return;
    let attached = null;
    const start = Date.now();
    const tick = () => {
      const video = document.querySelector('video');
      if (video && video !== attached) {
        attached = video;
        video.pause();
        video.addEventListener('play', () => video.pause());
        console.log(`${LOG_TAG} 자동재생 방지 — 영상 일시정지`);
      } else if (video && !video.paused) {
        video.pause();
      }
      if (Date.now() - start < PAUSE_POLL_MAX_MS) setTimeout(tick, PAUSE_POLL_INTERVAL_MS);
    };
    tick();
  }
  pauseVideoWhenReady();

  console.log(`${LOG_TAG} 준비됨 (${location.href})`);
})();
