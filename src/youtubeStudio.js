/**
 * Content Script: YouTube Studio 업로드 창 자동 입력
 *
 * 설계: background가 전달해주는 업로드 요청을 내부 큐에 쌓아두고, 두 개의 인터벌(각 1초)만
 * 써서 돈다.
 *  1. MainLoop: 큐에서 요청을 하나 꺼내, 8단계(만들기 클릭 → 동영상 업로드 클릭 → 파일 선택
 *     → 제목/설명/아동용 여부 → 재생목록 → 공개 범위 → 저장 → 완료 팝업 닫기)를 순서대로
 *     끝까지 처리할 때까지 기다린 뒤에만 다음 요청으로 넘어간다. 어느 단계든 실패하면
 *     파일 선택(3단계)/저장(7단계) 성공 여부에 따라 1·4·8단계 중 하나부터 다시 시작하고
 *     (저장까지 끝났으면 입력칸을 다시 찾을 필요 없이 완료 팝업 닫기만 재시도), 5번 연속
 *     "더 나아가지 못하면" 이 탭을 수동 대기 상태로 전환하고 background에 알린다(남은
 *     요청은 되돌려준다).
 *  2. 삭제 담당 Loop: 8단계를 모두 성공한 요청은 "삭제 대상 리스트"에 들어간다. 이 루프가
 *     매 틱마다 Studio의 동영상 목록에서 그 파일의 행을 찾아 "업로드됨" 여부를 보고,
 *     자동 삭제 설정이면 바로 지우고 아니면 패널에 수동 삭제 버튼을 띄운다.
 *
 * background와는 탭 재사용 가능 여부를 묻고 답하는 프로토콜(probe/restart) 자체가 없다 —
 * 순서 관리(큐)가 이 파일 안에만 있으므로, background는 "이 탭에 요청을 하나 전달한다"만
 * 하면 된다. 탭이 닫히거나 응답이 없으면 background가 알아서 새 탭을 연다.
 *
 * 탭을 처음 열면(`https://www.youtube.com/upload`는 채널 ID 없이도 쓸 수 있는 채널-무관
 * 경로라 이걸 그대로 쓴다) 첫 업로드 창이 이미 열린 카드형 대시보드가 뜨는데, 거기서는
 * 동영상이 카드로만 보여 업로드 완료 확인에 필요한 행(`ytcp-video-row`)이 전혀 없다.
 * "동영상" 섹션의 "모두보기"를 눌러 행 목록 화면으로 전환해야 하는데, 그 버튼은 첫
 * 업로드 창이 열려 있는 동안엔 찾을 수 없어 요청 처리의 선행 조건으로 걸 수 없다 — 그래서
 * MainLoop를 막지 않고 매 틱마다 `tryEnsureListView()`로 조용히 한 번씩만 시도하다
 * (보통 첫 업로드가 끝나 창이 닫힌 뒤 성공) 성공하면 더 이상 시도하지 않는다(`listViewReady`).
 * 끝내 못 찾아도 업로드는 계속되고 삭제 추적만 못 하는 정도로 그친다.
 *
 * 주의: Studio 화면의 DOM 구조에 기대는 코드라 유튜브가 UI를 바꾸면 아래 셀렉터를 고쳐야
 * 할 수 있다. 패널에는 지금 처리 중인 요청의 단계 진행 상황과 실패만 표시하고, 나머지는
 * 전부 콘솔 로그로 남긴다. 디버깅을 위해, 삭제 대상 리스트의 각 항목은 고유 색을 배정받아
 * Studio 목록의 해당 행 제목 색과 패널 항목 색을 일치시킨다 — 어느 행이 어느 항목으로
 * 추적되고 있는지 한눈에 확인할 수 있다.
 */

(() => {
  const LOG_TAG = '[YoutubeStudio]';
  console.log(`${LOG_TAG} v${chrome.runtime.getManifest().version} 로드됨`);

  // ---------------------------------------------------------------------------
  // 타이밍 상수
  // ---------------------------------------------------------------------------
  const INTERVAL_MS = 1000; // MainLoop, 삭제 담당 Loop 공통 주기
  const MAX_STAGNANT_RETRIES = 5; // 같은 요청을 재시작해도 더 나아가지 못한 횟수가 이걸 넘으면 수동 대기
  const RETRY_DELAY_MS = 1500; // 같은 요청을 재시작하기 전 짧은 대기(Studio UI 연타 방지)
  const FOLDER_WAIT_POLL_MS = 1000; // 폴더 권한 대기 중 재확인 주기

  const STEP_WAIT_MS = 5000;
  const OPEN_DIALOG_TIMEOUT_MS = 8000;
  // 파일을 input에 넣은 뒤 Studio가 상세 화면으로 넘어가지 않으면 반응하지 않은 것으로 본다.
  const ATTACH_REACTION_TIMEOUT_MS = 15000;
  // Studio가 파일명으로 제목을 자동 채운 뒤 덮어쓰는 경우를 대비해 확인 후 재입력한다.
  const VERIFY_DELAY_MS = 1000;
  const MAX_FILL_ATTEMPTS = 4;
  // 재생목록 창은 열린 직후엔 비어 있다가 계정의 재생목록을 불러온 뒤에야 채워진다.
  const PLAYLIST_LOAD_TIMEOUT_MS = 20000;
  const PLAYLIST_STABLE_MS = 800;
  const PLAYLIST_ROW_GRACE_MS = 3000;
  // 저장 버튼을 누른 뒤 완료/공유 화면의 닫기 버튼이 나타날 때까지 기다리는 최대 시간.
  const SAVE_PROCESSING_TIMEOUT_MS = 20000;
  // Studio에서 무언가를 클릭하기 전에는 항상 "조건이 참임을 확인 → 이만큼 대기 → 다시
  // 확인해서 그때도 참이어야 클릭"을 거친다(confirmFound/waitForStable 참고) — Studio는
  // SPA라 화면이 막 바뀌는 도중 옛 엘리먼트와 새 엘리먼트가 잠깐 뒤섞여 보일 수 있어서,
  // 한 번만 보고 바로 누르면 곧 사라지거나 다른 엘리먼트로 교체될 것을 잘못 누를 위험이 있다.
  const CONFIRM_GAP_MS = 1000;

  // 저장 직후 목록에 남아있던 동일 제목의 옛 행을 새 업로드로 오인하지 않도록, 삭제 대상
  // 리스트에 들어간 시점(≈저장 완료 시점)으로부터 이만큼은 무조건 기다린 뒤에야 업로드
  // 완료(「업로드됨」) 확인을 시작한다.
  const MIN_DELAY_AFTER_SAVE_MS = 60 * 1000;
  // "업로드됨" 텍스트가 뜨길 기다리는 시간 — 대용량 VOD와 느린 회선을 고려해 넉넉하게 잡는다.
  // 이 시간을 넘기도록 확인이 안 되면 추적을 포기한다.
  const UPLOAD_ROW_DONE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
  // "완료"를 본 뒤에도 잠깐 더 지켜봐서 일시적인 순간이 아닌지 확인한 다음에만 삭제한다.
  const UPLOAD_ROW_DONE_CONFIRM_MS = 5000;
  // 삭제 대기(자동 삭제 대상) 파일이 이 개수 이상 쌓이면 디스크 공간 보호를 위해 새 업로드
  // 요청 처리를 잠깐 멈춘다 — 다른 페이지에는 알리지 않고 이 탭 혼자 판단/처리한다.
  const PENDING_DELETION_THROTTLE = 10;

  // ---------------------------------------------------------------------------
  // 셀렉터 — 유튜브가 Studio UI를 바꾸면 여기를 고쳐야 한다. 모든 자동 입력/선택은 반드시
  // "업로드 창" 안에서만 한다 — 이미 올라간 영상의 편집 화면에도 같은 입력칸이 있어서,
  // 범위를 제한하지 않으면 엉뚱한 영상을 건드릴 수 있다.
  // ---------------------------------------------------------------------------
  const UPLOAD_DIALOG_SELECTOR = 'ytcp-uploads-dialog';
  const SHARE_DIALOG_SELECTOR = 'ytcp-video-share-dialog';
  const FILE_INPUT_SELECTOR = 'input[type="file"]';
  const TITLE_SELECTORS = ['#title-textarea #textbox', 'ytcp-video-title #textbox', '#title-textarea [contenteditable]'];
  const DESCRIPTION_SELECTORS = [
    '#description-textarea #textbox',
    'ytcp-video-description #textbox',
    '#description-textarea [contenteditable]',
  ];
  const NOT_FOR_KIDS_SELECTORS = [
    'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
    '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
  ];
  const PLAYLIST_TRIGGER_SELECTORS = [
    'ytcp-video-metadata-playlists ytcp-text-dropdown-trigger',
    'ytcp-video-metadata-playlists ytcp-dropdown-trigger',
    'ytcp-video-metadata-playlists',
  ];
  const PLAYLIST_POPUP_SELECTOR = 'ytcp-playlist-dialog';
  const PLAYLIST_DONE_SELECTORS = ['.done-button', 'ytcp-button.done-button'];
  const VISIBILITY_RADIO_NAMES = { private: 'PRIVATE', unlisted: 'UNLISTED', public: 'PUBLIC' };
  const VISIBILITY_LABELS = { private: '비공개', unlisted: '일부 공개', public: '공개' };
  const VISIBILITY_STEP_BADGE_SELECTOR = '#step-badge-3';
  const NEXT_BUTTON_SELECTOR = '#next-button';
  const DONE_BUTTON_SELECTOR = '#done-button';
  const CREATE_BUTTON_SELECTORS = ['button[aria-label="만들기"]', 'button[aria-label="Create"]', '#create-icon'];
  const UPLOAD_MENU_ITEM_SELECTORS = ['tp-yt-paper-item#text-item-0', '#text-item-0'];
  const UPLOAD_MENU_ITEM_TEXTS = ['동영상 업로드', 'Upload videos', 'Upload video'];
  const DIALOG_CLOSE_BUTTON_SELECTORS = [
    'button[aria-label="닫기"]',
    'button[aria-label="Close"]',
    '#close-button',
    'ytcp-button#close-button',
  ];
  const DIALOG_CLOSE_BUTTON_TEXTS = ['닫기', 'Close'];
  const UPLOAD_ROW_SELECTOR = 'ytcp-video-row';
  const UPLOAD_ROW_TITLE_SELECTOR = '#video-title';
  const UPLOAD_ROW_DESCRIPTION_SELECTOR = '.cell-description';
  const UPLOAD_DONE_TEXT = '업로드됨';
  // 카드형 대시보드의 "동영상" 섹션에서 행 목록 화면으로 넘어가는 "모두보기" 버튼 — 실제
  // Studio 화면에서 확인한 값. 구조가 바뀌면 깨질 수 있어 텍스트 매칭을 백업으로 둔다.
  const VIDEOS_VIEW_ALL_BUTTON_SELECTOR =
    '#main > div > ytcp-animatable.page.selected.style-scope.ytcp-app.style-scope.ytcp-app > ytcp-browse-page > ytcp-section-list-renderer > div.ytcpSectionListRendererContents > ytcp-item-section-renderer:nth-child(1) > div > div > horizontal-shelf-view-model > div.ytwHorizontalShelfViewModelHeader > yt-section-header-view-model > yt-shelf-header-layout > div > div.ytShelfHeaderLayoutTrailingActions > div > yt-flexible-actions-view-model > div > button-view-model > button';
  const VIDEOS_VIEW_ALL_BUTTON_TEXTS = ['모두보기', 'View all'];

  const STEP_LABELS = {
    1: '"만들기" 버튼 클릭',
    2: '"동영상 업로드" 메뉴 클릭',
    3: '파일 선택',
    4: '제목/설명/아동용 여부 입력',
    5: '재생목록 선택',
    6: '공개 범위 선택',
    7: '저장 버튼 클릭',
    8: '완료 팝업 닫기',
  };

  // 디버깅용: 삭제 대상 리스트의 각 항목에 순서대로 배정하는 색 팔레트. Studio 목록의 해당
  // 행 제목 색과 패널 항목 색을 일치시켜, 어느 행이 어느 항목으로 추적되고 있는지(또는
  // 지금 추적이 끊겼는지) 한눈에 확인할 수 있게 한다.
  const DEBUG_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#009688', '#f032e6', '#9a6324', '#e6b800', '#008080'];

  // 연결한 다운로드 폴더 핸들은 이 페이지(studio.youtube.com) 출처의 IndexedDB에 보관한다.
  const DB_NAME = 'private-extension-vod-upload';
  const DB_STORE = 'handles';
  const DIR_HANDLE_KEY = 'downloadDir';

  // ---------------------------------------------------------------------------
  // 모듈 상태 — 기능별로 묶어서, 어떤 변수가 어떤 역할인지 한눈에 알 수 있게 한다.
  // ---------------------------------------------------------------------------
  let requestQueue = []; // 업로드 요청 대기열
  let manualWaitMode = false; // 5회 연속 정체로 수동 대기 상태가 됐는지
  let requestSeq = 0; // 로그 태그용 요청 번호(요청마다 1씩 증가)

  let deletionList = []; // 8단계를 모두 성공한 요청들 — 삭제 담당 Loop가 추적
  let colorCounter = 0;

  let dirHandle = null; // 연결된 다운로드 폴더 핸들

  let mainLoopRunning = false;
  let deletionLoopRunning = false;
  let listViewReady = false; // "모두보기"를 눌러 행 목록 화면으로 전환했는지(한 탭에 1회)

  init();

  async function init() {
    await loadSavedDirHandle();
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    setInterval(runMainLoopTick, INTERVAL_MS);
    setInterval(runDeletionLoopTick, INTERVAL_MS);
  }

  /**
   * 탭을 처음 열면(`youtube.com/upload`) 카드형 대시보드가 뜨는데, 거기엔 행(`ytcp-video-row`)
   * 이 없어 업로드 완료 확인(삭제 담당 Loop)이 아무것도 못 찾는다. "동영상" 섹션의
   * "모두보기"를 한 번 눌러 행 목록 화면으로 넘어가야 하는데, 그 버튼은 **첫 업로드 창이
   * 아직 열려 있는 동안은 찾을 수 없다**(대시보드가 그 패널에 가려져 있거나 안 그려짐) —
   * `youtube.com/upload`가 바로 그 창을 띄운 채로 열리기 때문에, 이 전환을 요청 처리의
   * 선행 조건으로 걸면 첫 업로드가 끝나기만 기다리는 교착 상태가 된다. 그래서 MainLoop를
   * 막지 않고, 매 틱마다(= 첫 업로드가 끝나 창이 닫힌 뒤 언젠가) 조용히 한 번씩 시도만
   * 한다 — 늦게라도 한 번만 성공하면 그 뒤로는 다시 시도하지 않는다(`listViewReady`).
   * 끝내 못 찾아도 업로드 자체는 계속되고, 삭제 추적만 못 하는 정도로 그친다.
   */
  let ensureListViewInFlight = false;

  function tryEnsureListView() {
    if (listViewReady || ensureListViewInFlight) return;
    ensureListViewInFlight = true;
    ensureListViewOnce().finally(() => {
      ensureListViewInFlight = false;
    });
  }

  async function ensureListViewOnce() {
    if (document.querySelector(UPLOAD_ROW_SELECTOR)) {
      listViewReady = true;
      console.log(`${LOG_TAG} 동영상 목록(행) 화면 확인됨 — 삭제 추적 가능`);
      return;
    }
    const button = await confirmFound(findVideosViewAllButton);
    if (!button) return; // 아직 못 찾음(업로드 창에 가려짐 등) — 다음 틱에 다시 시도

    button.click();
    console.log(`${LOG_TAG} "모두보기" 클릭 — 목록 화면 전환 시도`);
    const appeared = await waitFor(() => document.querySelector(UPLOAD_ROW_SELECTOR), STEP_WAIT_MS);
    if (appeared) {
      listViewReady = true;
      console.log(`${LOG_TAG} 동영상 목록(행) 화면으로 전환 완료 — 삭제 추적 가능`);
    } else {
      console.warn(`${LOG_TAG} "모두보기" 클릭했지만 목록을 찾지 못함 — 다음 기회에 다시 시도`);
    }
  }

  function findVideosViewAllButton() {
    return document.querySelector(VIDEOS_VIEW_ALL_BUTTON_SELECTOR) || findButtonByText(document, VIDEOS_VIEW_ALL_BUTTON_TEXTS);
  }

  function handleBackgroundMessage(request) {
    if (request?.action === 'studio:newRequest') {
      enqueueRequest(request.payload);
      return false;
    }
    if (request?.action === 'studio:discardQueued') {
      console.log(`${LOG_TAG} 대기 중이던 업로드 요청 ${requestQueue.length}개를 모두 폐기함`);
      requestQueue = [];
      renderQueueStatus();
      return false;
    }
    return false;
  }

  /** 요청을 받아 정규화해 큐에 넣는다. 이미 수동 대기 상태라면 이 탭에서는 처리할 수 없으니
   *  즉시 background로 돌려보내 다른(새) 탭이 맡게 한다. */
  function enqueueRequest(rawPayload) {
    const payload = {
      title: rawPayload.title,
      description: rawPayload.description,
      fileNames: Array.isArray(rawPayload.fileNames) ? rawPayload.fileNames : [],
      videoId: rawPayload.videoId ?? null,
      fileOrder: rawPayload.fileOrder != null ? Number(rawPayload.fileOrder) : null,
      downloadSubfolder: rawPayload.downloadSubfolder || '',
      options: {
        visibility: rawPayload.options?.visibility || 'unlisted',
        notForKids: rawPayload.options?.notForKids !== false,
        playlists: Array.isArray(rawPayload.options?.playlists) ? rawPayload.options.playlists : [],
        deleteAfterUpload: Boolean(rawPayload.options?.deleteAfterUpload),
      },
    };

    if (manualWaitMode) {
      console.warn(`${LOG_TAG} 수동 대기 상태라 요청을 받지 않고 background로 돌려보냄: ${payload.title}`);
      chrome.runtime.sendMessage({ action: 'studio:tabUnusable', leftoverRequests: [payload] }).catch(() => {});
      return;
    }

    requestQueue.push(payload);
    console.log(`${LOG_TAG} 업로드 요청 큐에 추가 (대기 ${requestQueue.length}개): ${payload.title}`);
    renderQueueStatus();
  }

  // ---------------------------------------------------------------------------
  // MainLoop — 큐에서 요청을 하나 꺼내 끝까지(성공 또는 포기) 처리한 뒤에만 다음으로 넘어간다.
  // ---------------------------------------------------------------------------
  async function runMainLoopTick() {
    tryEnsureListView(); // 기회가 될 때마다(보통 첫 업로드 창이 닫힌 뒤) 조용히 한 번만 시도 — 큐 처리를 막지 않음
    if (mainLoopRunning || manualWaitMode) return;
    if (requestQueue.length === 0) return;

    const autoPendingCount = deletionList.filter((d) => !d.manual).length;
    if (autoPendingCount >= PENDING_DELETION_THROTTLE) return; // 디스크 공간 보호 — 조용히 건너뜀

    mainLoopRunning = true;
    try {
      const payload = requestQueue.shift();
      renderQueueStatus();
      await processRequest(payload);
    } finally {
      mainLoopRunning = false;
    }
  }

  /**
   * 요청 하나를 8단계로 처리한다. 실패하면 파일 선택(3단계)/저장(7단계) 성공 여부에 따라
   * 1단계, 4단계, 또는 8단계부터 다시 시작하고(아래 saved/fileSelected 분기), 재시작해도
   * 도달한 최고 단계가 갱신되지 않는 횟수(stagnant)가 MAX_STAGNANT_RETRIES를 넘으면 이
   * 요청을 포기하고 탭을 수동 대기 상태로 전환한다. 포기한 요청은 어디에도 실패로 보고하지
   * 않는다 — 패널/콘솔에만 남는다(단, 저장까지는 성공했다면 삭제 추적 대상에는 넣는다).
   */
  async function processRequest(payload) {
    const seq = (requestSeq += 1);
    const tag = `${LOG_TAG} [요청 #${seq}]`;
    const baselineRowCount = rowsMatchingTitle(payload.title).length;
    console.log(`${tag} 처리 시작: ${payload.title} (기준 행 개수 ${baselineRowCount})`, payload);

    let fileSelected = false;
    // 저장(7단계)까지 한 번이라도 성공했으면, 그 뒤로는 실패해도 1·4단계로 되돌아가지 않고
    // 8단계(완료 팝업 닫기)만 다시 시도한다 — 저장은 이미 끝나 Studio에 올라간 뒤라 제목/
    // 설명/저장 버튼을 다시 누르는 건 의미가 없고, 이미 사라진 업로드 창에서 그 입력칸들을
    // 다시 찾으려다 오히려 매번 실패한다(아래 saved 분기).
    let saved = false;
    let bestStep = 0;
    let stagnantRetries = 0;

    for (;;) {
      const startStep = saved ? 8 : fileSelected ? 4 : 1;
      const result = await runRequestAttempt(tag, payload, startStep, seq);

      if (result.ok) {
        console.log(`${tag} 모든 단계 완료`);
        setPanelStep(seq, 8, '완료', false);
        addToDeletionList(payload, baselineRowCount);
        return;
      }

      fileSelected = fileSelected || result.fileSelected;
      saved = saved || result.saved;
      const reachedStep = result.failedAtStep - 1;
      if (reachedStep > bestStep) {
        bestStep = reachedStep;
        stagnantRetries = 0;
      } else {
        stagnantRetries += 1;
      }

      console.warn(
        `${tag} ${result.failedAtStep}단계(${STEP_LABELS[result.failedAtStep]}) 실패: ${result.reason} — 정체 ${stagnantRetries}/${MAX_STAGNANT_RETRIES}`
      );
      setPanelStep(seq, result.failedAtStep, `실패: ${result.reason} (재시도 중)`, true);

      if (stagnantRetries > MAX_STAGNANT_RETRIES) {
        console.warn(`${tag} 5회 연속 진전 없음 — 이 요청을 포기하고 탭을 수동 대기 상태로 전환`);
        setPanelStep(seq, result.failedAtStep, '포기 — 수동 대기 상태로 전환됨', true);
        // 저장(7단계)까지는 성공했다면 실제로는 업로드가 끝난 것이므로, 닫기(8단계)만
        // 끝내 못 해도 삭제 추적 대상에는 넣어준다 — 안 그러면 실제로 올라간 파일이 삭제
        // 추적에서 영원히 빠진다.
        if (saved) {
          console.log(`${tag} 저장은 이미 성공했으므로(닫기만 실패) 삭제 추적 대상에 추가함`);
          addToDeletionList(payload, baselineRowCount);
        }
        enterManualWaitMode();
        return;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  function enterManualWaitMode() {
    if (manualWaitMode) return;
    manualWaitMode = true;
    const leftovers = requestQueue.splice(0, requestQueue.length);
    renderQueueStatus();
    setStatusText('⚠ 수동 대기 상태 — 더 이상 자동으로 처리하지 않습니다. Studio에서 직접 확인해주세요.', true);
    chrome.runtime.sendMessage({ action: 'studio:tabUnusable', leftoverRequests: leftovers }).catch(() => {});
  }

  /** startStep부터 8단계까지 순서대로 진행한다(startStep===8이면 저장은 이미 끝났다고
   *  보고 완료 팝업 닫기만 재시도한다 — 업로드 창 자체가 이미 사라졌으니 1~7단계는
   *  건너뛴다). 실패 시 { ok:false, failedAtStep, reason, fileSelected, saved }를 돌려준다
   *  (fileSelected/saved는 이번 시도에서 각각 파일 선택/저장을 지나쳤는지). */
  async function runRequestAttempt(tag, payload, startStep, seq) {
    if (startStep <= 7) {
      let dialog;

      if (startStep === 1) {
        await cleanupStrayDialogs();
        setPanelStep(seq, 1, STEP_LABELS[1], false);
        const opened = await openUploadDialog();
        if (!opened.ok) return { ok: false, failedAtStep: opened.failedAtStep, reason: opened.reason, fileSelected: false, saved: false };
        dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
      } else {
        dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
        if (!dialog) return { ok: false, failedAtStep: 4, reason: '업로드 창이 사라짐', fileSelected: true, saved: false };
      }

      if (startStep <= 3) {
        setPanelStep(seq, 3, STEP_LABELS[3], false);
        const r = await selectFile(dialog, payload);
        if (!r.ok) return { ok: false, failedAtStep: 3, reason: r.reason, fileSelected: false, saved: false };
        console.log(`${tag} 파일 첨부 완료: ${r.detail}`);
      }

      setPanelStep(seq, 4, STEP_LABELS[4], false);
      const titleBox = await waitForStable(() => findFirst(dialog, TITLE_SELECTORS), STEP_WAIT_MS);
      const descBox = await waitForStable(() => findFirst(dialog, DESCRIPTION_SELECTORS), STEP_WAIT_MS);
      if (!titleBox || !descBox) return { ok: false, failedAtStep: 4, reason: '제목/설명 입력칸을 찾지 못함', fileSelected: true, saved: false };
      const [titleOk, descOk] = await Promise.all([fillWithVerify(titleBox, payload.title), fillWithVerify(descBox, payload.description)]);
      if (!titleOk || !descOk) return { ok: false, failedAtStep: 4, reason: '제목/설명 입력 실패', fileSelected: true, saved: false };
      if (payload.options.notForKids) {
        const r = await selectNotForKids(dialog);
        if (!r.ok) return { ok: false, failedAtStep: 4, reason: `아동용 여부 선택 실패(${r.detail || ''})`, fileSelected: true, saved: false };
      }
      console.log(`${tag} 제목/설명/아동용 여부 입력 완료`);

      if (payload.options.playlists.length > 0) {
        setPanelStep(seq, 5, STEP_LABELS[5], false);
        const r = await selectPlaylists(dialog, payload.options.playlists);
        if (!r.ok) return { ok: false, failedAtStep: 5, reason: `재생목록 선택 실패(${r.detail || ''})`, fileSelected: true, saved: false };
        console.log(`${tag} 재생목록 선택 완료: ${r.detail}`);
      }

      setPanelStep(seq, 6, STEP_LABELS[6], false);
      const visibilityLabel = VISIBILITY_LABELS[payload.options.visibility] || payload.options.visibility;
      const visResult = await selectVisibility(dialog, payload.options.visibility);
      if (!visResult.ok) return { ok: false, failedAtStep: 6, reason: `공개 범위(${visibilityLabel}) 선택 실패`, fileSelected: true, saved: false };
      console.log(`${tag} 공개 범위(${visibilityLabel}) 선택 완료`);

      setPanelStep(seq, 7, STEP_LABELS[7], false);
      const saveResult = await clickSaveButton(dialog);
      if (!saveResult.ok) return { ok: false, failedAtStep: 7, reason: saveResult.reason, fileSelected: true, saved: false };
      console.log(`${tag} 저장 버튼 클릭 완료`);
    }

    setPanelStep(seq, 8, STEP_LABELS[8], false);
    const closeResult = await closeCompletionPopup();
    if (!closeResult.ok) return { ok: false, failedAtStep: 8, reason: closeResult.reason, fileSelected: true, saved: true };
    console.log(`${tag} 완료 팝업 닫기 완료`);

    return { ok: true };
  }

  /** 1단계(만들기)로 재시작하기 전, 이전 시도가 남겨둔 열린 업로드/공유 창을 정리한다.
   *  못 찾거나 못 닫아도 무시하고 진행한다(1단계 자체가 실패하면 그 상태로 재시도 루프를 탄다). */
  async function cleanupStrayDialogs() {
    for (const selector of [UPLOAD_DIALOG_SELECTOR, SHARE_DIALOG_SELECTOR]) {
      const dialog = document.querySelector(selector);
      if (!dialog) continue;
      const closeButton = await confirmFound(
        () => findFirst(dialog, DIALOG_CLOSE_BUTTON_SELECTORS) || findButtonByText(dialog, DIALOG_CLOSE_BUTTON_TEXTS)
      );
      closeButton?.click();
      await waitFor(() => !document.querySelector(selector), STEP_WAIT_MS);
    }
  }

  /**
   * 상단 "만들기" 버튼을 눌러 메뉴를 연 뒤 "동영상 업로드"(#text-item-0)를 눌러 업로드 창을 연다.
   * 1단계(만들기)와 2단계(메뉴 클릭) 실패를 구분해 돌려준다.
   */
  async function openUploadDialog() {
    const createButton = await waitForStable(() => findVisible(document, CREATE_BUTTON_SELECTORS), STEP_WAIT_MS);
    if (!createButton) return { ok: false, failedAtStep: 1, reason: '"만들기" 버튼을 찾지 못함' };
    createButton.click();

    const item =
      (await waitForStable(findUploadMenuItem, STEP_WAIT_MS)) || (await confirmFound(() => document.querySelectorAll('#text-item-0')[0]));
    if (!item) {
      console.warn(`${LOG_TAG} "동영상 업로드" 메뉴 항목을 찾지 못함. 메뉴 항목:`, listMenuItemTexts());
      return { ok: false, failedAtStep: 2, reason: '"동영상 업로드" 메뉴 항목을 찾지 못함' };
    }
    item.click();

    const opened = await waitFor(() => document.querySelector(UPLOAD_DIALOG_SELECTOR), OPEN_DIALOG_TIMEOUT_MS);
    if (!opened) return { ok: false, failedAtStep: 2, reason: '업로드 창이 열리지 않음' };
    return { ok: true };
  }

  function findUploadMenuItem() {
    return findMenuItemByText(UPLOAD_MENU_ITEM_TEXTS) || findVisible(document, UPLOAD_MENU_ITEM_SELECTORS);
  }

  function listMenuItemTexts() {
    return Array.from(document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]')).map(
      (el) => `${normalize(el.textContent)}${isVisible(el) ? '' : ' (숨김)'}`
    );
  }

  function findMenuItemByText(texts) {
    const wanted = texts.map(normalize);
    const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]');
    return (
      Array.from(items).find((el) => {
        if (!isVisible(el)) return false;
        const label = normalize(el.textContent);
        return wanted.some((w) => label === w || label.startsWith(w));
      }) || null
    );
  }

  /**
   * 파일을 input에 넣는다. 폴더가 아직 연결/허용되지 않은 경우는 실패가 아니라 "대기"로
   * 보고, 재시도 횟수를 늘리지 않은 채 사용자가 폴더를 연결할 때까지 이 함수 안에서 계속
   * 기다린다(바깥 재시도 루프가 1단계부터 반복하면 매번 업로드 창을 새로 열게 돼 낭비다).
   * 폴더는 있는데 파일을 못 찾거나 Studio가 반응하지 않으면 그건 진짜 실패로 취급한다.
   */
  async function selectFile(dialog, payload) {
    if (payload.fileNames.length === 0) {
      setFolderPromptVisible(false);
      return { ok: true, detail: '첨부할 파일 없음(수동 선택 필요)' };
    }

    for (;;) {
      if (!dialog.isConnected) return { ok: false, reason: '업로드 창이 사라짐' };
      const input = dialog.querySelector(FILE_INPUT_SELECTOR);
      if (!input) return { ok: false, reason: '파일 입력칸을 찾지 못함' };

      if (!(await hasReadPermission())) {
        setFolderPromptVisible(true);
        await sleep(FOLDER_WAIT_POLL_MS);
        continue; // 실패가 아니라 대기 — 재시도 횟수에 영향 없음
      }
      setFolderPromptVisible(false);

      const file = await findDownloadedFile(payload.fileNames, payload.downloadSubfolder);
      if (!file) return { ok: false, reason: `폴더에서 '${payload.fileNames[0]}'을(를) 찾지 못함` };

      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const reacted = await waitFor(
        () => findFirst(dialog, TITLE_SELECTORS) && findFirst(dialog, DESCRIPTION_SELECTORS),
        ATTACH_REACTION_TIMEOUT_MS
      );
      if (!reacted) return { ok: false, reason: 'Studio가 파일 첨부에 반응하지 않음' };
      return { ok: true, detail: file.name };
    }
  }

  /** "아동용이 아닙니다" 라디오 선택 */
  async function selectNotForKids(dialog) {
    const radio = await waitForStable(() => findFirst(dialog, NOT_FOR_KIDS_SELECTORS), STEP_WAIT_MS);
    if (!radio) return { ok: false, detail: '선택 항목을 찾지 못함' };
    return { ok: await ensureChecked(radio) };
  }

  /** 재생목록 드롭다운을 열어 설정에 저장된 이름들을 (여러 개) 체크하고 "완료" */
  async function selectPlaylists(dialog, names) {
    const trigger = await waitForStable(() => findFirst(dialog, PLAYLIST_TRIGGER_SELECTORS), STEP_WAIT_MS);
    if (!trigger) return { ok: false, detail: '재생목록 드롭다운을 찾지 못함' };
    trigger.click();

    const popup = await waitFor(() => document.querySelector(PLAYLIST_POPUP_SELECTOR), STEP_WAIT_MS);
    if (!popup) return { ok: false, detail: '재생목록 창이 열리지 않음' };

    const loaded = await waitForPlaylistRows(popup);
    if (!loaded) {
      const giveUpButton = await confirmFound(() => findFirst(popup, PLAYLIST_DONE_SELECTORS));
      giveUpButton?.click();
      return { ok: false, detail: '재생목록이 불러와지지 않음' };
    }

    const missing = [];
    for (const name of names) {
      const row = await waitForStable(() => findPlaylistRow(popup, name), PLAYLIST_ROW_GRACE_MS);
      if (!row) {
        missing.push(name);
        continue;
      }
      const checkbox = row.querySelector('ytcp-checkbox-lit') || row;
      if (!(await ensureChecked(checkbox))) missing.push(name);
    }

    const done = await confirmFound(() => findFirst(popup, PLAYLIST_DONE_SELECTORS) || findButtonByText(popup, ['완료', 'Done']));
    if (done) done.click();

    if (missing.length > 0) return { ok: false, detail: `못 찾음/선택 실패: ${missing.join(', ')}` };
    return { ok: true, detail: `${names.length}개` };
  }

  /** 공개 범위 라디오 선택. 라디오는 마지막 단계에 있어서 그 단계로 이동해야 할 수 있다. */
  async function selectVisibility(dialog, visibility) {
    const name = VISIBILITY_RADIO_NAMES[visibility] || VISIBILITY_RADIO_NAMES.unlisted;
    const findRadio = () => dialog.querySelector(`[name="${name}"]`);

    let radio = await confirmFound(findRadio);
    if (!radio) {
      const badge = await confirmFound(() => dialog.querySelector(VISIBILITY_STEP_BADGE_SELECTOR));
      if (badge) {
        badge.click();
        radio = await waitForStable(findRadio, 3000);
      }
    }
    if (!radio) {
      for (let i = 0; i < 3 && !radio; i += 1) {
        const next = await confirmFound(() => dialog.querySelector(NEXT_BUTTON_SELECTOR));
        if (next) next.click();
        radio = await waitForStable(findRadio, 2500);
      }
    }
    if (!radio) return { ok: false, detail: '공개 범위 선택 항목을 찾지 못함' };

    const ok = await ensureChecked(radio);
    // 마지막 단계에 머물러 사용자가 바로 "저장"을 누를 수 있게 한다(실패해도 무시).
    const backBadge = await confirmFound(() => dialog.querySelector(VISIBILITY_STEP_BADGE_SELECTOR));
    backBadge?.click();
    return { ok };
  }

  async function clickSaveButton(dialog) {
    const saveButton = await confirmFound(() => dialog.querySelector(DONE_BUTTON_SELECTOR));
    if (!saveButton) return { ok: false, reason: '저장 버튼을 찾지 못함' };
    saveButton.click();
    return { ok: true };
  }

  /** 저장 후 나타나는 완료/공유 화면의 닫기 버튼을 찾아 누른다. 그 화면을 감싸는 요소가
   *  확실치 않아(미검증) 컨테이너로 좁히지 않고 화면 전체에서 보이는 버튼을 찾는다. */
  async function closeCompletionPopup() {
    const closeButton = await waitForStable(findSaveCompletionCloseButton, SAVE_PROCESSING_TIMEOUT_MS);
    if (!closeButton) return { ok: false, reason: '완료 화면의 닫기 버튼을 찾지 못함' };
    closeButton.click();
    const popupGone = await waitFor(() => !findSaveCompletionCloseButton(), STEP_WAIT_MS);
    if (!popupGone) return { ok: false, reason: '완료 팝업이 닫히지 않음' };
    return { ok: true };
  }

  function findSaveCompletionCloseButton() {
    return findVisible(document, DIALOG_CLOSE_BUTTON_SELECTORS) || findVisibleButtonByText(document, DIALOG_CLOSE_BUTTON_TEXTS);
  }

  // ---------------------------------------------------------------------------
  // 삭제 담당 Loop — 8단계를 모두 성공한 요청(deletionList 항목)마다, Studio 목록에서 그
  // 행을 찾아 "업로드됨"이 떴는지 확인한다. 자동 삭제 설정이면 바로 지우고, 아니면 패널에
  // 수동 삭제 버튼을 띄운다.
  // ---------------------------------------------------------------------------

  function addToDeletionList(payload, baselineRowCount) {
    if (payload.videoId == null || payload.fileOrder == null) {
      console.log(`${LOG_TAG} videoId/fileOrder가 없어 삭제 추적 대상에서 제외: ${payload.title}`);
      return;
    }
    const entry = {
      key: `${payload.videoId}:${payload.fileOrder}`,
      videoId: payload.videoId,
      fileOrder: payload.fileOrder,
      title: payload.title,
      baselineRowCount,
      savedAt: Date.now(),
      autoDelete: payload.options.deleteAfterUpload,
      manual: !payload.options.deleteAfterUpload,
      color: DEBUG_COLORS[colorCounter % DEBUG_COLORS.length],
      row: null,
      firstSeenDoneAt: null,
      readyForManualDelete: false,
      deleting: false,
    };
    colorCounter += 1;
    deletionList.push(entry);
    console.log(`${LOG_TAG} 삭제 추적 대상 추가: ${entry.key} (${entry.manual ? '수동' : '자동'} 삭제)`, entry.title);
    renderDeletionPanel();
  }

  function removeFromDeletionList(entry) {
    const index = deletionList.indexOf(entry);
    if (index >= 0) deletionList.splice(index, 1);
    renderDeletionPanel();
  }

  async function runDeletionLoopTick() {
    if (deletionLoopRunning) return;
    deletionLoopRunning = true;
    try {
      for (const entry of [...deletionList]) {
        await tickDeletionEntry(entry);
      }
      renderDeletionPanel();
    } finally {
      deletionLoopRunning = false;
    }
  }

  async function tickDeletionEntry(entry) {
    if (entry.deleting) return;
    if (Date.now() - entry.savedAt < MIN_DELAY_AFTER_SAVE_MS) return;

    const rows = rowsMatchingTitle(entry.title);
    const row = rows.length > entry.baselineRowCount ? rows[0] : null;

    if (!row) {
      if (entry.row) unpaintRow(entry);
      entry.row = null;
      entry.firstSeenDoneAt = null;
      giveUpIfTimedOut(entry, '행을 끝내 찾지 못함');
      return;
    }

    entry.row = row;
    paintRow(entry, row);

    if (!isUploadMarkedDone(row)) {
      entry.firstSeenDoneAt = null;
      giveUpIfTimedOut(entry, '업로드 완료("업로드됨")를 끝내 확인하지 못함');
      return;
    }

    if (entry.firstSeenDoneAt == null) {
      entry.firstSeenDoneAt = Date.now();
      return; // 다음 틱에 안정성 재확인(플루크 방지)
    }
    if (Date.now() - entry.firstSeenDoneAt < UPLOAD_ROW_DONE_CONFIRM_MS) return;

    entry.readyForManualDelete = true;
    if (entry.autoDelete) await deleteEntry(entry);
  }

  function giveUpIfTimedOut(entry, reason) {
    if (Date.now() - entry.savedAt <= UPLOAD_ROW_DONE_TIMEOUT_MS) return;
    console.warn(`${LOG_TAG} ${entry.key} 추적 포기(${reason}) — 로컬 파일은 지우지 않음`);
    removeFromDeletionList(entry);
  }

  async function deleteEntry(entry) {
    entry.deleting = true;
    renderDeletionPanel();
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'download:deleteUploaded',
        videoId: entry.videoId,
        fileOrder: entry.fileOrder,
      });
      if (response?.success) {
        console.log(`${LOG_TAG} 로컬 파일 삭제됨: ${entry.key}${response.name ? ` (${response.name})` : ''}`);
        unpaintRow(entry);
        removeFromDeletionList(entry);
        return;
      }
      console.warn(`${LOG_TAG} 로컬 파일 삭제 실패: ${entry.key} — ${response?.error}`);
    } catch (error) {
      console.warn(`${LOG_TAG} 로컬 파일 삭제 요청 오류: ${entry.key}`, error);
    }
    entry.deleting = false;
    renderDeletionPanel();
  }

  function paintRow(entry, row) {
    const titleEl = row.querySelector(UPLOAD_ROW_TITLE_SELECTOR);
    if (titleEl) titleEl.style.color = entry.color;
  }

  function unpaintRow(entry) {
    const titleEl = entry.row?.querySelector?.(UPLOAD_ROW_TITLE_SELECTOR);
    if (titleEl) titleEl.style.color = '';
  }

  /** 동영상 목록에서 제목이 정확히 일치하는 행들을, 최신순 정렬 기준 DOM 순서 그대로
   *  돌려준다(첫 번째가 가장 최근). 개수 비교(baselineRowCount와)로 "새로 생긴 행"을
   *  가리고, [0]으로 "가장 최근 행"을 가리키는 두 용도를 이 함수 하나로 통일했다. */
  function rowsMatchingTitle(title) {
    const target = normalize(title);
    const matches = [];
    for (const row of document.querySelectorAll(UPLOAD_ROW_SELECTOR)) {
      const titleEl = row.querySelector(UPLOAD_ROW_TITLE_SELECTOR);
      if (!titleEl) continue;
      const label = normalize(titleEl.getAttribute('aria-label') || titleEl.textContent);
      if (label === target) matches.push(row);
    }
    return matches;
  }

  /** 이 행에 "업로드됨" 텍스트가 실제로 "보이는" 상태로 표시됐는지(부분 일치 없이 정확히
   *  일치해야 한다). Studio가 상태별 텍스트를 미리 다 만들어두고 display만 토글할 가능성에
   *  대비해, 후보를 전부 찾아 그중 보이는 것만 비교한다. */
  function isUploadMarkedDone(row) {
    for (const cell of row.querySelectorAll(UPLOAD_ROW_DESCRIPTION_SELECTOR)) {
      if (!isVisible(cell)) continue;
      if (normalize(cell.textContent) === UPLOAD_DONE_TEXT) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 파일 자동 첨부 (File System Access API)
  // ---------------------------------------------------------------------------

  async function loadSavedDirHandle() {
    try {
      dirHandle = await loadDirHandle();
    } catch (error) {
      console.warn(`${LOG_TAG} 저장된 폴더 핸들을 불러오지 못함`, error);
      dirHandle = null;
    }
  }

  async function hasReadPermission() {
    if (!dirHandle) return false;
    try {
      return (await dirHandle.queryPermission({ mode: 'read' })) === 'granted';
    } catch (error) {
      return false;
    }
  }

  async function onFolderButtonClick() {
    try {
      if (dirHandle) {
        const state = await dirHandle.requestPermission({ mode: 'read' });
        if (state !== 'granted') {
          setStatusText('폴더 접근이 허용되지 않았습니다.', true);
          return;
        }
      } else {
        if (!window.showDirectoryPicker) {
          setStatusText('이 브라우저에서는 폴더 선택을 지원하지 않습니다. mp4를 직접 선택해주세요.', true);
          return;
        }
        dirHandle = await window.showDirectoryPicker({ id: 'soop-vod-download', mode: 'read' });
        await saveDirHandle(dirHandle);
      }
      setFolderPromptVisible(false);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn(`${LOG_TAG} 폴더 연결 실패`, error);
        setStatusText(`폴더 연결 실패: ${error.message}`, true);
      }
    }
  }

  async function findDownloadedFile(fileNames, downloadSubfolder) {
    const matchers = buildNameMatchers(fileNames);

    const direct = await searchDirectory(dirHandle, matchers);
    if (direct) return direct;

    if (downloadSubfolder) {
      try {
        let dir = dirHandle;
        for (const part of downloadSubfolder.split('/').filter(Boolean)) {
          dir = await dir.getDirectoryHandle(part);
        }
        return await searchDirectory(dir, matchers);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  async function searchDirectory(directory, matchers) {
    let newest = null;
    for await (const entry of directory.values()) {
      if (entry.kind !== 'file') continue;
      if (!matchers.some((matcher) => matcher.test(entry.name))) continue;
      const file = await entry.getFile();
      if (!newest || file.lastModified > newest.lastModified) newest = file;
    }
    return newest;
  }

  /**
   * 후보 이름마다 "이름" 또는 브라우저가 중복 시 붙이는 "이름 (1)" 형태, 그리고
   * Windows에서 쓸 수 없는 문자가 치환된 형태까지 정확히 일치하는 파일만 인정한다.
   * 부분 일치는 허용하지 않는다 — "_1.mp4"와 "_10.mp4"처럼 비슷한 다른 파일을 집을 수 있다.
   */
  function buildNameMatchers(names) {
    const variants = new Set();
    for (const name of names) {
      variants.add(name);
      variants.add(name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-'));
      variants.add(name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_'));
    }
    return Array.from(variants).map((name) => {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      return new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?${escapeRegExp(ext)}$`, 'i');
    });
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function loadDirHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DIR_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveDirHandle(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(handle, DIR_HANDLE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ---------------------------------------------------------------------------
  // 배너/패널 UI — Shadow DOM. 모든 공개 함수가 맨 앞에서 ensureBanner()를 불러, 배너가
  // (원인 불명으로) document에서 떨어져 나가도 구조적으로 자가복구한다 — "먼저 불러야
  // 한다"는 관례가 아니라 각 함수 자체에 내장돼 있다.
  // ---------------------------------------------------------------------------
  const BANNER_HOST_ID = 'private-extension-youtube-studio-banner';
  let bannerHostEl = null;
  let statusEl = null;
  let queueStatusEl = null;
  let folderButtonEl = null;
  let deletionHeaderEl = null;
  let deletionListEl = null;

  let lastStatusText = '자동 업로드 대기 중...';
  let lastStatusIsError = false;
  let lastFolderPromptVisible = false;

  function ensureBanner() {
    if (bannerHostEl && bannerHostEl.isConnected) return;

    document.getElementById(BANNER_HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = BANNER_HOST_ID;
    host.style.cssText = 'position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    bannerHostEl = host;

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .banner { width: 340px; max-height: calc(100vh - 40px); overflow-y: auto; padding: 12px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); font: 13px/1.4 Arial, sans-serif; }
        .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        strong { font-size: 13px; color: #374151; }
        .close { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: #f1f5f9; color: #475569; cursor: pointer; }
        .status { margin: 0 0 4px; font-size: 12px; color: #4b5563; white-space: pre-line; }
        .status.error { color: #dc2626; }
        .queue-status { margin: 0 0 8px; font-size: 11px; color: #6b7280; }
        .folder { width: 100%; margin-bottom: 8px; padding: 7px; border: 0; border-radius: 5px; background: #2563eb; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .folder:hover { background: #1d4ed8; }
        .folder[hidden] { display: none; }
        .deletion-section { border-top: 1px solid #e5e7eb; padding-top: 8px; }
        .deletion-header { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #374151; }
        .deletion-list { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
        .deletion-list li { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #4b5563; padding: 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; word-break: break-all; }
        .swatch { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; }
        .label { flex: 1; }
        .delete-btn { flex: 0 0 auto; padding: 3px 7px; border: 0; border-radius: 4px; background: #dc2626; color: #fff; cursor: pointer; font-size: 11px; }
        .delete-btn:disabled { opacity: .6; cursor: default; }
      </style>
      <div class="banner">
        <div class="top"><strong>🎬 YT 업로드 자동화</strong><button class="close" id="close" title="닫기">×</button></div>
        <p class="status" id="status"></p>
        <p class="queue-status" id="queueStatus"></p>
        <button class="folder" id="folderButton" hidden>📁 다운로드 폴더 연결(파일 자동 첨부)</button>
        <div class="deletion-section">
          <p class="deletion-header" id="deletionHeader">삭제 대기 중인 파일 (0개)</p>
          <ul class="deletion-list" id="deletionList"></ul>
        </div>
      </div>`;

    statusEl = shadowRoot.getElementById('status');
    queueStatusEl = shadowRoot.getElementById('queueStatus');
    folderButtonEl = shadowRoot.getElementById('folderButton');
    folderButtonEl.addEventListener('click', onFolderButtonClick);
    deletionHeaderEl = shadowRoot.getElementById('deletionHeader');
    deletionListEl = shadowRoot.getElementById('deletionList');
    shadowRoot.getElementById('close').addEventListener('click', () => host.remove());

    // 복구된 경우(또는 최초 생성) 마지막으로 알려진 상태를 바로 반영한다. 대기열 개수는
    // 따로 캐시해둘 필요 없이 requestQueue를 그때그때 그대로 읽으면 된다.
    statusEl.textContent = lastStatusText;
    statusEl.classList.toggle('error', lastStatusIsError);
    queueStatusEl.textContent = `대기 중인 업로드 요청: ${requestQueue.length}개`;
    folderButtonEl.hidden = !lastFolderPromptVisible;
    renderDeletionListOnly();
  }

  /** requestQueue가 바뀔 때마다(추가/시작/폐기/수동 대기 반환) 호출해 패널의 대기열 표시를 맞춘다. */
  function renderQueueStatus() {
    ensureBanner();
    queueStatusEl.textContent = `대기 중인 업로드 요청: ${requestQueue.length}개`;
  }

  function setStatusText(text, isError = false) {
    ensureBanner();
    lastStatusText = text;
    lastStatusIsError = isError;
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function setPanelStep(seq, stepNumber, label, isError) {
    setStatusText(`[요청 #${seq}] ${stepNumber}/8 ${label}`, isError);
  }

  function setFolderPromptVisible(visible) {
    ensureBanner();
    lastFolderPromptVisible = visible;
    folderButtonEl.hidden = !visible;
  }

  function renderDeletionPanel() {
    ensureBanner();
    renderDeletionListOnly();
  }

  function renderDeletionListOnly() {
    deletionHeaderEl.textContent = `삭제 대기 중인 파일 (${deletionList.length}개)`;
    deletionListEl.textContent = '';
    for (const entry of deletionList) {
      const li = document.createElement('li');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = entry.color;
      li.appendChild(swatch);

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${entry.title}${entry.manual ? ' (수동 삭제 필요)' : ''} — ${describeEntryStatus(entry)}`;
      li.appendChild(label);

      if (entry.manual && entry.readyForManualDelete) {
        const button = document.createElement('button');
        button.className = 'delete-btn';
        button.disabled = entry.deleting;
        button.textContent = entry.deleting ? '삭제 중...' : '🗑 지금 삭제';
        button.addEventListener('click', () => deleteEntry(entry));
        li.appendChild(button);
      }

      deletionListEl.appendChild(li);
    }
  }

  function describeEntryStatus(entry) {
    if (entry.deleting) return '삭제하는 중...';
    if (entry.readyForManualDelete) return entry.manual ? '업로드됨 — 수동 삭제 대기' : '업로드됨 — 자동 삭제 예정';
    return '업로드 확인 대기 중';
  }

  // ---------------------------------------------------------------------------
  // 범용 DOM 헬퍼
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVisible(root, selectors) {
    for (const selector of selectors) {
      const match = Array.from(root.querySelectorAll(selector)).find(isVisible);
      if (match) return match;
    }
    return null;
  }

  function findFirst(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function findButtonByText(root, texts) {
    const wanted = texts.map(normalize);
    return (
      Array.from(root.querySelectorAll('ytcp-button, button')).find((btn) => wanted.includes(normalize(btn.textContent))) || null
    );
  }

  function findVisibleButtonByText(root, texts) {
    const wanted = texts.map(normalize);
    return (
      Array.from(root.querySelectorAll('ytcp-button, button')).find((btn) => isVisible(btn) && wanted.includes(normalize(btn.textContent))) ||
      null
    );
  }

  function getPlaylistRows(root) {
    const rows = Array.from(root.querySelectorAll('li'));
    const candidates = rows.length > 0 ? rows : Array.from(root.querySelectorAll('ytcp-checkbox-lit'));
    return candidates.filter((row) => normalize(row.textContent) !== '');
  }

  async function waitForPlaylistRows(popup) {
    const startedAt = Date.now();
    let lastCount = -1;
    let stableSince = Date.now();

    while (Date.now() - startedAt < PLAYLIST_LOAD_TIMEOUT_MS) {
      const count = getPlaylistRows(popup).length;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      } else if (count > 0 && Date.now() - stableSince >= PLAYLIST_STABLE_MS) {
        return true;
      }
      await sleep(200);
    }
    return lastCount > 0;
  }

  function findPlaylistRow(root, name) {
    const target = normalize(name);
    return getPlaylistRows(root).find((row) => rowHasText(row, target)) || null;
  }

  function rowHasText(row, target) {
    if (normalize(row.textContent) === target) return true;
    return Array.from(row.querySelectorAll('*')).some((el) => el.children.length === 0 && normalize(el.textContent) === target);
  }

  function isChecked(el) {
    if (el.getAttribute('aria-checked') === 'true' || el.hasAttribute('checked') || el.checked === true) return true;
    return Boolean(el.querySelector('[aria-checked="true"]'));
  }

  /** 이미 선택돼 있으면 그대로 두고(토글로 해제되지 않게), 아니면 눌러서 선택 여부를 확인한다. */
  async function ensureChecked(el) {
    if (isChecked(el)) return true;
    el.click();
    await sleep(400);
    if (isChecked(el)) return true;

    const inner = el.querySelector('#radioContainer, #checkbox, [role="checkbox"], [role="radio"]');
    if (inner) {
      inner.click();
      await sleep(400);
    }
    return isChecked(el);
  }

  async function waitFor(getter, timeoutMs, intervalMs = 200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = getter();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  /**
   * getter()가 지금 당장 참이면 CONFIRM_GAP_MS만큼 기다린 뒤 다시 한 번 확인해서, 그때도
   * 참이어야 그 값을(재확인 시점의 최신 참조로) 돌려준다 — Studio가 화면을 다시 그리는
   * 도중 우연히 한 순간만 조건에 맞아 보이는 엘리먼트를 성급하게 클릭하는 사고를 막기
   * 위함. 처음부터 거짓이면 기다리지 않고 그대로 null. Studio에서 무언가를 클릭하기
   * 전에는 항상 이 함수(또는 이를 쓰는 waitForStable)를 거쳐서 얻은 엘리먼트만 누른다
   * (ensureChecked 자신의 클릭은 예외 — 호출 시점에 이미 confirmFound/waitForStable로
   * 얻은 특정 참조이므로 재확인이 중복이고, 대신 클릭의 "효과"를 재확인한다).
   */
  async function confirmFound(getter, confirmGapMs = CONFIRM_GAP_MS) {
    const first = getter();
    if (!first) return null;
    await sleep(confirmGapMs);
    return getter() || null;
  }

  async function waitForStable(getter, timeoutMs, intervalMs = 200, confirmGapMs = CONFIRM_GAP_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const confirmed = await confirmFound(getter, confirmGapMs);
      if (confirmed) return confirmed;
      await sleep(intervalMs);
    }
    return null;
  }

  async function fillWithVerify(box, text) {
    for (let attempt = 0; attempt < MAX_FILL_ATTEMPTS; attempt += 1) {
      if (!box.isConnected) return false;
      setEditableText(box, text);
      await sleep(VERIFY_DELAY_MS);
      if (normalize(box.innerText || box.textContent) === normalize(text)) return true;
    }
    return false;
  }

  /**
   * contenteditable 입력칸에 텍스트를 넣는다. execCommand를 쓰는 이유: 값만 바꾸면
   * Studio(Polymer)가 변경을 인식하지 못하는 경우가 있어서, 실제 타이핑처럼 동작하는
   * insertText 경로가 가장 안정적이다.
   */
  function setEditableText(box, text) {
    box.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand('delete');
    const lines = text.split('\n');
    let ok = true;
    lines.forEach((line, index) => {
      if (index > 0) ok = document.execCommand('insertLineBreak') && ok;
      if (line) ok = document.execCommand('insertText', false, line) && ok;
    });

    if (!ok) {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function normalize(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
