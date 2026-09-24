/**
 * Content Script: YouTube Studio 업로드 창 자동 입력
 * VOD 페이지의 "유튜브에 업로드" 버튼이 background를 통해 이 탭에 맡겨둔 제목/설명/파일명과
 * 설정 페이지에 저장해둔 옵션(아동용 아님, 재생목록, 공개 범위)을, Studio 업로드 창에 자동으로
 * 입력/선택한다. 다운로드 폴더를 연결해두면 mp4 파일도 자동으로 첨부한다. 마지막 "저장"
 * 클릭은 사용자가 직접 한다.
 * 백그라운드가 직접 연 탭에서만 동작하며(youtubeStudio:init 응답이 pending일 때),
 * 사용자가 평소에 쓰는 Studio 탭에는 아무 영향이 없다.
 * 업로드 창이 비어 있는(저장까지 끝난) 탭은 새 업로드를 위해 재사용된다: background가
 * youtubeStudio:probe로 물어보고, 가능하면 youtubeStudio:restart로 이 탭에서 "동영상 업로드"를
 * 다시 눌러 새 데이터로 같은 자동 입력을 진행한다. 진행 중이거나 저장 전인 탭은 절대 건드리지 않는다.
 *
 * 주의: Studio 화면의 DOM 구조에 기대는 코드라 유튜브가 UI를 바꾸면 아래 셀렉터를
 * 고쳐야 할 수 있다. 각 단계는 독립적으로 실패해도 다른 단계를 막지 않고, 결과를
 * 배너에 단계별로 표시한다. 제목/설명은 배너의 "복사" 버튼으로 수동 대체할 수 있다.
 */

(() => {
  const LOG_TAG = '[YoutubeStudio]';
  const BANNER_HOST_ID = 'private-extension-youtube-studio-banner';

  const POLL_INTERVAL_MS = 500;
  // 사용자가 mp4를 고르기까지 오래 걸릴 수 있어 넉넉히 기다린다.
  const POLL_TIMEOUT_MS = 30 * 60 * 1000;
  // Studio가 파일명으로 제목을 자동 채운 뒤 덮어쓰는 경우를 대비해 확인 후 재입력한다.
  const VERIFY_DELAY_MS = 1000;
  const MAX_FILL_ATTEMPTS = 4;
  const STEP_WAIT_MS = 5000;
  // 재생목록 창은 열린 직후엔 비어 있다가 계정의 재생목록을 불러온 뒤에야 채워진다.
  const PLAYLIST_LOAD_TIMEOUT_MS = 20000; // 목록이 나타나길 기다리는 최대 시간
  const PLAYLIST_STABLE_MS = 800; // 행 개수가 이만큼 변하지 않으면 다 불러온 것으로 본다
  const PLAYLIST_ROW_GRACE_MS = 3000; // 다 불러온 뒤에도 못 찾은 이름을 마지막으로 기다리는 시간
  // 파일을 input에 넣은 뒤 Studio가 상세 화면으로 넘어가지 않으면 반응하지 않은 것으로 본다.
  const ATTACH_REACTION_TIMEOUT_MS = 15000;

  // 모든 자동 입력/선택은 반드시 "업로드 창" 안에서만 한다 — 이미 올라간 영상의 편집
  // 화면에도 같은 입력칸이 있어서, 범위를 제한하지 않으면 엉뚱한 영상을 건드릴 수 있다.
  const UPLOAD_DIALOG_SELECTOR = 'ytcp-uploads-dialog';
  const FILE_INPUT_SELECTOR = 'input[type="file"]';
  const TITLE_SELECTORS = [
    '#title-textarea #textbox',
    'ytcp-video-title #textbox',
    '#title-textarea [contenteditable]',
  ];
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

  // 이미 열려 있는 Studio 탭에서 새 업로드를 시작할 때 쓰는 "만들기 → 동영상 업로드" 메뉴,
  // 그리고 저장 후 남아 있을 수 있는 완료 화면을 닫는 버튼
  // 콘솔에서 `button[aria-label="만들기"]`.click() → `#text-item-0`.click() 순서로 업로드 창이 열리는 것을 확인했다.
  const CREATE_BUTTON_SELECTORS = ['button[aria-label="만들기"]', 'button[aria-label="Create"]', '#create-icon'];
  const UPLOAD_MENU_ITEM_SELECTORS = ['tp-yt-paper-item#text-item-0', '#text-item-0'];
  const UPLOAD_MENU_ITEM_TEXTS = ['동영상 업로드', 'Upload videos', 'Upload video'];
  const DIALOG_CLOSE_BUTTON_SELECTORS = ['#close-button', 'ytcp-button#close-button'];
  const DIALOG_CLOSE_BUTTON_TEXTS = ['닫기', 'Close'];
  const OPEN_DIALOG_TIMEOUT_MS = 8000;
  // 저장 후 업로드 창 대신(또는 뒤이어) 뜰 수 있는 "동영상 게시됨" 공유 창
  const SHARE_DIALOG_SELECTOR = 'ytcp-video-share-dialog';

  // 연결한 다운로드 폴더 핸들은 이 페이지(studio.youtube.com) 출처의 IndexedDB에 보관한다.
  // 폴더 핸들은 확장 프로그램 페이지(설정 페이지 등)와 이 페이지 사이에 옮길 수 없다.
  const DB_NAME = 'private-extension-vod-upload';
  const DB_STORE = 'handles';
  const DIR_HANDLE_KEY = 'downloadDir';

  const DEFAULT_OPTIONS = { visibility: 'unlisted', notForKids: true, playlists: [] };

  let bannerMessageEl = null;
  let folderButtonEl = null;

  // 현재 진행 중인(또는 마지막) 업로드 실행의 데이터와 상태. 같은 탭에서 새 업로드를 시작하면
  // (youtubeStudio:restart) beginRun이 이 값들을 통째로 새로 채운다.
  let currentTitle = '';
  let currentDescription = '';
  let currentOptions = DEFAULT_OPTIONS;
  let fileNames = []; // 자동 첨부할 파일의 후보 이름들 (VOD 페이지가 넘겨줌)
  let downloadSubfolder = '';
  let dirHandle = null;
  let folderLoaded = false;
  let forcePickFolder = false; // 파일을 못 찾았을 때 다른 폴더를 고르게 하기 위함
  let attachStarted = false;
  let attachDone = false;
  let attachResult = null;
  let automationStarted = false;

  // 'waiting'(업로드 창/파일 대기) → 'automating'(자동 입력 중) → 'ready'(입력 끝, 사용자의 저장 대기)
  // → 'saved'(저장 클릭). 재사용 가능 여부 판단에 쓴다.
  let runPhase = 'waiting';
  let dialogEverSeen = false;
  let watchTimer = null;
  let currentRunId = 0; // 재시작 후 이전 실행의 늦은 콜백이 끼어들지 못하게 하는 세대 번호
  const saveWatchedDialogs = new WeakSet();

  init();

  async function init() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'youtubeStudio:init' });
    } catch (error) {
      return; // 확장 컨텍스트가 아직 준비되지 않음
    }
    if (!response?.pending) return;

    // 우리가 연 탭에서만 background의 재사용 요청(probe/restart)에 응답한다.
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    showBanner();
    await beginRun(response);
  }

  /** 새 업로드 데이터로 상태를 초기화하고 업로드 창 감시를 (다시) 시작한다. */
  async function beginRun(payload) {
    stopWatching();
    currentRunId += 1;

    currentTitle = payload.title;
    currentDescription = payload.description;
    currentOptions = { ...DEFAULT_OPTIONS, ...(payload.options || {}) };
    fileNames = Array.isArray(payload.fileNames) ? payload.fileNames : [];
    downloadSubfolder = payload.downloadSubfolder || '';
    forcePickFolder = false;
    attachStarted = false;
    attachDone = false;
    attachResult = null;
    automationStarted = false;
    runPhase = 'waiting';

    console.log(`${LOG_TAG} 업로드 실행 시작`, currentTitle, currentOptions, fileNames);
    setBannerMessage(
      '업로드 창이 열리면 제목/설명과 설정해둔 옵션을 자동으로 채워드립니다.' +
        (fileNames.length > 0 ? ' 다운로드 폴더를 연결해두면 mp4도 자동으로 첨부합니다.' : '')
    );

    if (fileNames.length > 0 && !folderLoaded) await setupFolderAccess();
    else await refreshFolderButton();
    startWatching();
  }

  function handleBackgroundMessage(request, sender, sendResponse) {
    if (request?.action === 'youtubeStudio:probe') {
      sendResponse({ reusable: isReusable() });
      return false;
    }
    if (request?.action === 'youtubeStudio:restart') {
      restartInThisTab(request.payload).then(sendResponse);
      return true;
    }
    return false;
  }

  /**
   * 이 탭에서 새 업로드를 시작해도 되는지. 자동 입력 중이거나, 업로드 창이 열려 있는데 아직
   * 저장을 누르지 않았다면(파일 선택 대기 포함) 진행 중인 작업이므로 재사용하지 않는다.
   * 업로드 창을 한 번도 못 본 탭(막 열려서 아직 창이 뜨기 전)도 안전하게 재사용하지 않는다.
   */
  function isReusable() {
    if (runPhase === 'automating') return false;
    const dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
    if (dialog) {
      dialogEverSeen = true;
      return runPhase === 'saved'; // 저장 후 남아 있는 완료 화면만 닫고 재사용할 수 있다
    }
    return dialogEverSeen || runPhase !== 'waiting';
  }

  async function restartInThisTab(payload) {
    const failWith = (reason) => {
      console.warn(`${LOG_TAG} 이 탭에서 새 업로드를 시작하지 못함: ${reason}`);
      setBannerMessage(`이 탭에서 새 업로드를 시작하지 못했습니다 (${reason}). 새 탭으로 열립니다.`, true);
      return { started: false, reason };
    };

    try {
      if (!isReusable()) return { started: false, reason: '진행 중인 업로드가 있음' };

      showBanner(); // 사용자가 배너를 닫았어도 다시 보이게
      setBannerMessage('새 업로드를 시작하는 중...');

      // 이전 실행의 감시를 먼저 멈춘다 — 새로 열릴 업로드 창에 이전 데이터가 입력되면 안 된다.
      stopWatching();
      currentRunId += 1;

      const leftover = document.querySelector(UPLOAD_DIALOG_SELECTOR);
      if (leftover && !(await closeFinishedDialog(leftover))) {
        return failWith('이전 업로드 완료 화면을 닫지 못함');
      }
      const share = document.querySelector(SHARE_DIALOG_SELECTOR);
      if (share && !(await closeFinishedDialog(share, SHARE_DIALOG_SELECTOR))) {
        return failWith('이전 업로드 완료 화면을 닫지 못함');
      }
      const opened = await openUploadDialog();
      if (!opened.ok) return failWith(opened.reason);

      dialogEverSeen = true;
      await beginRun(payload);
      return { started: true };
    } catch (error) {
      console.warn(`${LOG_TAG} 재시작 중 오류`, error);
      return failWith('오류 발생');
    }
  }

  /** 저장 후 남아 있는 완료 화면을 닫는다. 저장 전(=진행 중) 창은 isReusable이 이미 걸러낸다. */
  async function closeFinishedDialog(dialog, selector = UPLOAD_DIALOG_SELECTOR) {
    const button = findFirst(dialog, DIALOG_CLOSE_BUTTON_SELECTORS) || findButtonByText(dialog, DIALOG_CLOSE_BUTTON_TEXTS);
    if (button) button.click();
    return Boolean(await waitFor(() => !document.querySelector(selector), STEP_WAIT_MS));
  }

  /**
   * 상단 "만들기" 버튼을 눌러 메뉴를 연 뒤 "동영상 업로드"(#text-item-0)를 눌러 업로드 창을 연다.
   * 실패 시 어느 단계에서 막혔는지 reason으로 알려준다(Studio 화면 구조가 바뀌었을 때 원인을 바로 알 수 있게).
   */
  async function openUploadDialog() {
    const createButton = await waitFor(() => findVisible(document, CREATE_BUTTON_SELECTORS), STEP_WAIT_MS);
    if (!createButton) return { ok: false, reason: '"만들기" 버튼을 찾지 못함' };
    createButton.click();

    // 메뉴 항목이 DOM에는 숨겨진 채로 미리 있을 수 있어, 먼저 "보이는" 항목이 나타나길 기다린다.
    // 끝내 안 보이면 같은 id의 첫 번째 요소를 그대로 누른다(콘솔에서 이 방식으로 동작 확인).
    const item =
      (await waitFor(findUploadMenuItem, STEP_WAIT_MS)) || document.querySelectorAll('#text-item-0')[0];
    if (!item) {
      console.warn(`${LOG_TAG} "동영상 업로드" 메뉴 항목을 찾지 못함. 메뉴 항목:`, listMenuItemTexts());
      return { ok: false, reason: '"만들기" 메뉴에서 "동영상 업로드" 항목을 찾지 못함' };
    }

    console.log(`${LOG_TAG} "동영상 업로드" 메뉴 항목 클릭`, item);
    item.click();
    if (await waitFor(() => document.querySelector(UPLOAD_DIALOG_SELECTOR), OPEN_DIALOG_TIMEOUT_MS)) {
      return { ok: true };
    }
    return { ok: false, reason: '"동영상 업로드"를 눌렀지만 업로드 창이 열리지 않음' };
  }

  function findUploadMenuItem() {
    return findMenuItemByText(UPLOAD_MENU_ITEM_TEXTS) || findVisible(document, UPLOAD_MENU_ITEM_SELECTORS);
  }

  function listMenuItemTexts() {
    return Array.from(document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]')).map(
      (el) => `${normalize(el.textContent)}${isVisible(el) ? '' : ' (숨김)'}`
    );
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** 셀렉터 목록 중 화면에 실제로 보이는 첫 요소 */
  function findVisible(root, selectors) {
    for (const selector of selectors) {
      const match = Array.from(root.querySelectorAll(selector)).find(isVisible);
      if (match) return match;
    }
    return null;
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

  function stopWatching() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  function startWatching() {
    const runId = currentRunId;
    const startedAt = Date.now();

    watchTimer = setInterval(async () => {
      if (runId !== currentRunId) return; // 재시작으로 무효가 된 이전 실행

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        stopWatching();
        setBannerMessage('업로드 창을 찾지 못해 자동 입력을 중단했습니다. 아래 버튼으로 복사해 붙여넣어주세요.', true);
        return;
      }

      const dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
      if (!dialog) return;
      dialogEverSeen = true;

      tryAttach(); // 내부 가드가 있어 매 폴링마다 불러도 한 번만 실행된다

      const titleBox = findFirst(dialog, TITLE_SELECTORS);
      const descriptionBox = findFirst(dialog, DESCRIPTION_SELECTORS);
      if (!titleBox || !descriptionBox) return;

      stopWatching();
      automationStarted = true;
      runPhase = 'automating';
      watchForSave(dialog);
      console.log(`${LOG_TAG} 업로드 창의 제목/설명 입력칸 발견, 자동 입력 시작`);

      await runAutomation(dialog, titleBox, descriptionBox);
      if (runId === currentRunId && runPhase === 'automating') runPhase = 'ready';
    }, POLL_INTERVAL_MS);
  }

  /** 사용자가 Studio의 "저장"을 누르면 이 실행을 '저장됨'으로 표시한다(재사용 가능 판단용). */
  function watchForSave(dialog) {
    if (saveWatchedDialogs.has(dialog)) return;
    saveWatchedDialogs.add(dialog);
    dialog.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof Element && event.target.closest(DONE_BUTTON_SELECTOR)) {
          runPhase = 'saved';
          console.log(`${LOG_TAG} 저장 클릭 감지`);
        }
      },
      true
    );
  }

  async function runAutomation(dialog, titleBox, descriptionBox) {
    const options = currentOptions;
    const results = [];
    if (attachResult) results.push(attachResult);
    const report = () => setBannerMessage(formatResults(results, true));

    setBannerMessage(formatResults(results, false) + '\n제목/설명을 입력하는 중...');
    const [titleOk, descriptionOk] = await Promise.all([
      fillWithVerify(titleBox, currentTitle),
      fillWithVerify(descriptionBox, currentDescription),
    ]);
    results.push({ label: '제목', ok: titleOk });
    results.push({ label: '설명', ok: descriptionOk });
    report();

    // 각 단계는 서로 독립적으로 실패할 수 있고, 하나가 실패해도 나머지는 계속 진행한다.
    if (options.notForKids) {
      setBannerMessage(formatResults(results, false) + '\n"아동용이 아닙니다" 선택 중...');
      results.push(await safely('아동용이 아닙니다', () => selectNotForKids(dialog)));
      report();
    }

    if (options.playlists.length > 0) {
      setBannerMessage(formatResults(results, false) + '\n재생목록 선택 중...');
      results.push(await safely('재생목록', () => selectPlaylists(dialog, options.playlists)));
      report();
    }

    const visibilityLabel = VISIBILITY_LABELS[options.visibility] || options.visibility;
    setBannerMessage(formatResults(results, false) + `\n공개 범위(${visibilityLabel}) 선택 중...`);
    results.push(await safely(`공개 범위(${visibilityLabel})`, () => selectVisibility(dialog, options.visibility)));

    const allOk = results.every((r) => r.ok);
    console.log(`${LOG_TAG} 자동 입력 결과`, results);
    setBannerMessage(
      formatResults(results, true) +
        (allOk ? '\n업로드가 끝나면 Studio의 "저장"을 눌러주세요.' : '\n실패한 항목은 Studio에서 직접 설정해주세요.'),
      !allOk
    );
  }

  function formatResults(results, includeDetail) {
    return results
      .map((r) => `${r.ok ? '✓' : '✗'} ${r.label}${includeDetail && r.detail ? ` (${r.detail})` : ''}`)
      .join('\n');
  }

  async function safely(label, step) {
    try {
      const outcome = await step();
      return { label, ok: outcome.ok, detail: outcome.detail };
    } catch (error) {
      console.warn(`${LOG_TAG} ${label} 단계 오류:`, error);
      return { label, ok: false, detail: '오류 발생' };
    }
  }

  // ---------------------------------------------------------------------------
  // 파일 자동 첨부 (File System Access API)
  //
  // 브라우저는 경로 문자열로 <input type="file">을 채우는 걸 막는다. 대신 사용자가 다운로드
  // 폴더를 한 번 허용해주면(폴더 핸들), 그 폴더에서 파일명으로 찾은 실제 File 객체를
  // input.files에 넣고 change 이벤트를 발생시켜 Studio가 사용자가 고른 것처럼 받게 한다.
  // 폴더 선택창은 사용자 클릭이 있어야 열리므로 배너의 버튼으로 연결한다.
  // ---------------------------------------------------------------------------

  async function setupFolderAccess() {
    folderLoaded = true;
    try {
      dirHandle = await loadDirHandle();
    } catch (error) {
      console.warn(`${LOG_TAG} 저장된 폴더 핸들을 불러오지 못함`, error);
      dirHandle = null;
    }
    await refreshFolderButton();
  }

  async function hasReadPermission() {
    if (!dirHandle) return false;
    try {
      return (await dirHandle.queryPermission({ mode: 'read' })) === 'granted';
    } catch (error) {
      return false;
    }
  }

  async function refreshFolderButton() {
    if (!folderButtonEl) return;
    if (fileNames.length === 0 || attachDone || (!forcePickFolder && (await hasReadPermission()))) {
      folderButtonEl.hidden = true;
      return;
    }
    folderButtonEl.hidden = false;
    if (forcePickFolder) folderButtonEl.textContent = '📁 다른 폴더 선택 (파일을 못 찾았어요)';
    else if (dirHandle) folderButtonEl.textContent = '📁 폴더 접근 허용 (파일 자동 첨부)';
    else folderButtonEl.textContent = '📁 다운로드 폴더 연결 (파일 자동 첨부)';
  }

  async function onFolderButtonClick() {
    try {
      if (dirHandle && !forcePickFolder) {
        const state = await dirHandle.requestPermission({ mode: 'read' });
        if (state !== 'granted') {
          setBannerMessage('폴더 접근이 허용되지 않았습니다.', true);
          return;
        }
      } else {
        if (!window.showDirectoryPicker) {
          setBannerMessage('이 브라우저에서는 폴더 선택을 지원하지 않습니다. mp4를 직접 선택해주세요.', true);
          return;
        }
        dirHandle = await window.showDirectoryPicker({ id: 'soop-vod-download', mode: 'read' });
        await saveDirHandle(dirHandle);
        forcePickFolder = false;
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn(`${LOG_TAG} 폴더 연결 실패`, error);
        setBannerMessage(`폴더 연결 실패: ${error.message}`, true);
      }
      return;
    }

    if (!attachDone) attachStarted = false; // 새 폴더/권한으로 다시 시도
    await refreshFolderButton();
    tryAttach();
  }

  /** 업로드 창의 파일 입력칸이 보이고 폴더 접근이 허용돼 있으면, 한 번만 파일을 넣어본다. */
  async function tryAttach() {
    if (attachStarted || attachDone || fileNames.length === 0 || automationStarted) return;
    const runId = currentRunId;

    const dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
    const input = dialog?.querySelector(FILE_INPUT_SELECTOR);
    if (!input) return;
    if (!(await hasReadPermission())) return;
    if (attachStarted || attachDone) return; // 위 await 사이에 다른 호출이 먼저 시작했을 수 있음

    attachStarted = true;
    setBannerMessage('다운로드 폴더에서 파일을 찾는 중...');
    attachResult = await safely('파일 첨부', () => attachFile(input));
    if (runId !== currentRunId) return; // 그 사이 새 업로드로 재시작됨

    if (attachResult.ok) {
      attachDone = true;
      setBannerMessage(`✓ 파일 첨부 (${attachResult.detail})\nStudio가 파일을 받는 중...`);
      await refreshFolderButton();
      setTimeout(() => {
        if (runId === currentRunId && !automationStarted) {
          setBannerMessage('파일을 넣었지만 Studio가 반응하지 않았습니다. mp4를 직접 선택해주세요.', true);
        }
      }, ATTACH_REACTION_TIMEOUT_MS);
    } else {
      // 폴더가 틀렸을 가능성이 커서 다른 폴더를 고를 수 있게 한다. 자동 입력은 사용자가
      // 파일을 직접 고르면 그대로 이어진다.
      forcePickFolder = true;
      await refreshFolderButton();
      setBannerMessage(
        `✗ 파일 첨부 (${attachResult.detail})\nmp4를 직접 선택하거나 아래에서 다른 폴더를 골라주세요.`,
        true
      );
    }
  }

  async function attachFile(input) {
    const file = await findDownloadedFile();
    if (!file) return { ok: false, detail: `폴더에서 '${fileNames[0]}'을(를) 찾지 못함` };

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, detail: file.name };
  }

  async function findDownloadedFile() {
    const matchers = buildNameMatchers(fileNames);

    const direct = await searchDirectory(dirHandle, matchers);
    if (direct) return direct;

    // 다운로드 하위 폴더를 설정해뒀는데 그 상위 폴더를 연결한 경우도 찾아준다.
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
   * Windows에서 쓸 수 없는 문자가 '_'로 바뀐 형태까지 정확히 일치하는 파일만 인정한다.
   * 부분 일치는 허용하지 않는다 — "_1.mp4"와 "_10.mp4"처럼 비슷한 다른 파일을 집을 수 있다.
   */
  function buildNameMatchers(names) {
    const variants = new Set();
    for (const name of names) {
      variants.add(name);
      // 이 확장의 다운로드(background의 sanitizeFileName)와 Soop 공식 다운로드는 금지 문자를
      // '-'로, Chrome 자체 치환은 '_'로 바꾸므로 둘 다 후보로 둔다.
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
  // Studio 화면 조작 (아동용 아님 / 재생목록 / 공개 범위)
  // ---------------------------------------------------------------------------

  /** "아동용이 아닙니다" 라디오 선택 */
  async function selectNotForKids(dialog) {
    const radio = await waitFor(() => findFirst(dialog, NOT_FOR_KIDS_SELECTORS), STEP_WAIT_MS);
    if (!radio) return { ok: false, detail: '선택 항목을 찾지 못함' };
    return { ok: await ensureChecked(radio) };
  }

  /** 재생목록 드롭다운을 열어 설정에 저장된 이름들을 (여러 개) 체크하고 "완료" */
  async function selectPlaylists(dialog, names) {
    const trigger = await waitFor(() => findFirst(dialog, PLAYLIST_TRIGGER_SELECTORS), STEP_WAIT_MS);
    if (!trigger) return { ok: false, detail: '재생목록 드롭다운을 찾지 못함' };
    trigger.click();

    const popup = await waitFor(() => document.querySelector(PLAYLIST_POPUP_SELECTOR), STEP_WAIT_MS);
    if (!popup) return { ok: false, detail: '재생목록 창이 열리지 않음' };

    // 목록을 불러오기 전에 체크를 시도하면 전부 "못 찾음"이 되므로, 행이 나타나고 개수가
    // 안정될 때까지 기다린다.
    const loaded = await waitForPlaylistRows(popup);
    if (!loaded) {
      findFirst(popup, PLAYLIST_DONE_SELECTORS)?.click();
      return { ok: false, detail: '재생목록이 불러와지지 않음' };
    }

    const missing = [];
    for (const name of names) {
      // 이미 다 불러왔다면 바로 찾고, 늦게 도착하는 항목이 있을 수 있어 못 찾으면 잠깐 더 기다린다.
      const row = await waitFor(() => findPlaylistRow(popup, name), PLAYLIST_ROW_GRACE_MS);
      if (!row) {
        missing.push(name);
        continue;
      }
      const checkbox = row.querySelector('ytcp-checkbox-lit') || row;
      if (!(await ensureChecked(checkbox))) missing.push(name);
    }

    const done = findFirst(popup, PLAYLIST_DONE_SELECTORS) || findButtonByText(popup, ['완료', 'Done']);
    if (done) done.click();

    if (missing.length > 0) {
      return { ok: false, detail: `못 찾음/선택 실패: ${missing.join(', ')}` };
    }
    return { ok: true, detail: `${names.length}개` };
  }

  /** 공개 범위 라디오 선택. 라디오는 마지막 단계에 있어서 그 단계로 이동해야 할 수 있다. */
  async function selectVisibility(dialog, visibility) {
    const name = VISIBILITY_RADIO_NAMES[visibility] || VISIBILITY_RADIO_NAMES.unlisted;
    const findRadio = () => dialog.querySelector(`[name="${name}"]`);

    let radio = findRadio();
    if (!radio) {
      const badge = dialog.querySelector(VISIBILITY_STEP_BADGE_SELECTOR);
      if (badge) {
        badge.click();
        radio = await waitFor(findRadio, 3000);
      }
    }
    if (!radio) {
      // 단계 표시를 못 누르면 "다음" 버튼으로 세 단계를 넘어간다.
      for (let i = 0; i < 3 && !radio; i += 1) {
        const next = dialog.querySelector(NEXT_BUTTON_SELECTOR);
        if (next) next.click();
        radio = await waitFor(findRadio, 2500);
      }
    }
    if (!radio) return { ok: false, detail: '공개 범위 선택 항목을 찾지 못함' };

    const ok = await ensureChecked(radio);
    // 마지막 단계에 머물러 사용자가 바로 "저장"을 누를 수 있게 한다(실패해도 무시).
    dialog.querySelector(VISIBILITY_STEP_BADGE_SELECTOR)?.click();
    return { ok };
  }

  function getPlaylistRows(root) {
    const rows = Array.from(root.querySelectorAll('li'));
    const candidates = rows.length > 0 ? rows : Array.from(root.querySelectorAll('ytcp-checkbox-lit'));
    return candidates.filter((row) => normalize(row.textContent) !== '');
  }

  /**
   * 재생목록 행이 하나 이상 나타나고, 행 개수가 PLAYLIST_STABLE_MS 동안 변하지 않을 때까지
   * 기다린다(목록이 여러 번에 나눠 도착하는 경우를 위해 "나타났다"만이 아니라 "안정됐다"를 본다).
   */
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
    // 정확히 같은 이름만 인정한다 — 부분 일치를 허용하면 비슷한 이름의 다른 재생목록에
    // 조용히 들어가 버릴 수 있다.
    return getPlaylistRows(root).find((row) => rowHasText(row, target)) || null;
  }

  function rowHasText(row, target) {
    if (normalize(row.textContent) === target) return true;
    return Array.from(row.querySelectorAll('*')).some(
      (el) => el.children.length === 0 && normalize(el.textContent) === target
    );
  }

  function findButtonByText(root, texts) {
    const wanted = texts.map(normalize);
    return (
      Array.from(root.querySelectorAll('ytcp-button, button')).find((btn) =>
        wanted.includes(normalize(btn.textContent))
      ) || null
    );
  }

  function isChecked(el) {
    if (el.getAttribute('aria-checked') === 'true' || el.hasAttribute('checked') || el.checked === true) {
      return true;
    }
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

  function findFirst(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
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

    document.execCommand('delete'); // 기존 내용(파일명 기반 기본 제목 등) 삭제. 빈 칸이면 false라 결과는 무시
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

  function showBanner() {
    if (document.getElementById(BANNER_HOST_ID)) return;

    const host = document.createElement('div');
    host.id = BANNER_HOST_ID;
    host.style.cssText = 'position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;';
    document.documentElement.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .banner { width: 320px; padding: 12px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); font: 13px/1.4 Arial, sans-serif; }
        .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        strong { font-size: 13px; color: #374151; }
        .close { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: #f1f5f9; color: #475569; cursor: pointer; }
        .message { margin: 0 0 10px; font-size: 12px; color: #4b5563; white-space: pre-line; }
        .message.error { color: #dc2626; }
        .actions { display: flex; gap: 6px; }
        .copy { flex: 1; padding: 6px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; color: #2563eb; cursor: pointer; font-size: 12px; }
        .copy:hover { background: #eff6ff; }
        .folder { width: 100%; margin-top: 6px; padding: 7px; border: 0; border-radius: 5px; background: #2563eb; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .folder:hover { background: #1d4ed8; }
        .folder[hidden] { display: none; }
      </style>
      <div class="banner">
        <div class="top"><strong>🎬 VOD 업로드 도우미</strong><button class="close" id="close" title="닫기">×</button></div>
        <p class="message" id="message"></p>
        <div class="actions">
          <button class="copy" id="copyTitle">제목 복사</button>
          <button class="copy" id="copyDescription">설명 복사</button>
        </div>
        <button class="folder" id="folderButton" hidden></button>
      </div>`;

    bannerMessageEl = shadowRoot.getElementById('message');
    folderButtonEl = shadowRoot.getElementById('folderButton');
    folderButtonEl.addEventListener('click', onFolderButtonClick);
    shadowRoot.getElementById('close').addEventListener('click', () => host.remove());
    // 같은 탭에서 새 업로드로 재시작되면 값이 바뀌므로, 클릭 시점의 현재 값을 복사한다.
    bindCopyButton(shadowRoot.getElementById('copyTitle'), () => currentTitle, '제목 복사');
    bindCopyButton(shadowRoot.getElementById('copyDescription'), () => currentDescription, '설명 복사');
  }

  function bindCopyButton(button, getText, label) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        button.textContent = '복사됨!';
      } catch (error) {
        button.textContent = '복사 실패';
      }
      setTimeout(() => {
        button.textContent = label;
      }, 1500);
    });
  }

  function setBannerMessage(text, isError = false) {
    if (!bannerMessageEl) return;
    bannerMessageEl.textContent = text;
    bannerMessageEl.classList.toggle('error', isError);
  }
})();
