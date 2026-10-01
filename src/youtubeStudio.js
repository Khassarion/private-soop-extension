/**
 * Content Script: YouTube Studio 업로드 창 자동 입력
 * VOD 페이지의 "유튜브에 업로드" 버튼이 background를 통해 이 탭에 맡겨둔 제목/설명/파일명과
 * 설정 페이지에 저장해둔 옵션(아동용 아님, 재생목록, 공개 범위)을, Studio 업로드 창에 자동으로
 * 입력/선택한다. 다운로드 폴더를 연결해두면 mp4 파일도 자동으로 첨부한다. 모든 항목이
 * 성공적으로 채워지면 "저장" 버튼과, 그 뒤에 뜨는 완료/공유 팝업의 닫기 버튼까지 자동으로
 * 누른다(완전 자동화 진행 중). 하나라도 실패하면 저장은 시도하지 않고 사용자가 직접
 * 확인·저장하게 둔다.
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
  // 지금 로드된 게 최신 버전인지 콘솔에서 바로 확인할 수 있도록 매번 찍는다.
  console.log(`${LOG_TAG} v${chrome.runtime.getManifest().version} 로드됨`);

  /**
   * 로그 앞에 실행 번호("[실행 #N]")를 붙인다. 탭 재사용으로 이 탭에서 여러 번의 업로드
   * (=여러 파일)가 순서대로 진행되는데, "업로드 실행 시작" 로그의 currentRunId가 곧 그
   * 실행의 번호이고, 이후 그 실행에 관한 모든 로그(자동 입력, 저장, 닫기, 업로드 확인 등)를
   * 같은 번호로 찍어야 콘솔에서 "이 로그가 어느 파일 얘기인지"를 구분할 수 있다. runId를
   * 생략하면 지금 시점의 currentRunId를 쓴다 — runId 인자가 없는 함수(beginRun 등)에서 쓰되,
   * 이미 특정 실행의 runId를 캡처해 갖고 있는 함수(runAutomation, autoSaveAndClose,
   * watchForSave, watchUploadAndDelete 등)는 반드시 그 캡처값을 넘겨야 한다 — 탭 재사용으로
   * currentRunId가 이미 바뀐 뒤에 옛 실행의 로그가 새 실행 번호로 찍히는 걸 막기 위함이다.
   */
  function runTag(runId = currentRunId) {
    return `${LOG_TAG} [실행 #${runId}]`;
  }
  const BANNER_HOST_ID = 'private-extension-youtube-studio-banner';
  const ROW_BUTTON_HOST_ID = 'private-extension-youtube-studio-row-buttons';
  // 수동 삭제 대상 행에 버튼을 다시 그리는 주기 — Studio의 동영상 목록은 스크롤/가상화로
  // 행이 나타났다 사라졌다 하고 위치도 바뀌므로, 주기적으로 다시 찾아 위치를 맞춰준다.
  const ROW_BUTTON_SYNC_INTERVAL_MS = 1500;

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
  // 저장 버튼을 누른 뒤 완료/공유 화면의 닫기 버튼이 나타날 때까지 기다리는 최대 시간.
  const SAVE_PROCESSING_TIMEOUT_MS = 20000;
  // Studio에서 무언가를 클릭하기 전에는 항상 "조건이 참임을 확인 → 이만큼 대기 → 다시
  // 확인해서 그때도 참이어야 클릭"을 거친다(confirmFound/waitForStable 참고) — Studio는
  // SPA라 화면이 막 바뀌는 도중 옛 엘리먼트와 새 엘리먼트가 잠깐 뒤섞여 보일 수 있어서,
  // 한 번만 보고 바로 누르면 곧 사라지거나 다른 엘리먼트로 교체될 것을 잘못 누를 위험이
  // 있다. 저장 후 완료 화면의 닫기 버튼처럼 "눌러도 되는지" 자체가 민감한 경우 이 재확인이
  // 특히 중요했다(너무 빨리 누르면 Studio의 동영상 목록 행이 최신 상태로 갱신되기 전에
  // 재사용(다음 업로드)이 시작돼버리는 문제가 있었다 — 그 닫기 버튼을 누른 뒤에는 별도로
  // 이 파일의 새 행이 목록에 실제로 나타났는지까지 확인하고 나서야 재사용을 허용한다.
  // countRowsMatchingTitle/findRowByTitle 참고).
  const CONFIRM_GAP_MS = 1000;
  // 업로드 시작 직후 목록에 남아있던 동일 제목의 옛 행을 새 업로드로 오인해 바로
  // 삭제해버리는 사고를 막기 위해, 저장을 누른 시점부터 이만큼은 무조건 기다린 뒤에야
  // 업로드 완료(공개 상태 전환) 확인을 시작한다.
  const MIN_DELAY_AFTER_SAVE_MS = 60 * 1000;
  // 저장이 끝내 감지되지 않는 실행(자동화 실패 등)을 위한 대기 상한.
  const OWN_SAVE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

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
  // 실제 확인한 닫기 버튼은 id 없이 aria-label만 있는 순수 <button>이라 그것부터 찾는다.
  const DIALOG_CLOSE_BUTTON_SELECTORS = [
    'button[aria-label="닫기"]',
    'button[aria-label="Close"]',
    '#close-button',
    'ytcp-button#close-button',
  ];
  const DIALOG_CLOSE_BUTTON_TEXTS = ['닫기', 'Close'];
  const OPEN_DIALOG_TIMEOUT_MS = 8000;
  // 저장 후 업로드 창 대신(또는 뒤이어) 뜰 수 있는 "동영상 게시됨" 공유 창
  const SHARE_DIALOG_SELECTOR = 'ytcp-video-share-dialog';

  // 연결한 다운로드 폴더 핸들은 이 페이지(studio.youtube.com) 출처의 IndexedDB에 보관한다.
  // 폴더 핸들은 확장 프로그램 페이지(설정 페이지 등)와 이 페이지 사이에 옮길 수 없다.
  const DB_NAME = 'private-extension-vod-upload';
  const DB_STORE = 'handles';
  const DIR_HANDLE_KEY = 'downloadDir';

  const DEFAULT_OPTIONS = {
    visibility: 'unlisted',
    notForKids: true,
    playlists: [],
    deleteAfterUpload: false,
    // 다시보기 파이프라인이 시킨 업로드면, 삭제 설정과 무관하게 업로드 확인까지는 항상
    // 지켜보고 background에 알려줘야 한다(파이프라인이 다음 다시보기로 넘어갈 시점을
    // 그걸로 판단한다).
    pipeline: false,
  };

  // ---------------------------------------------------------------------------
  // 업로드(파일 전송) 완료 감지 — "업로드 확인 후 로컬 파일 자동 삭제" 기능용.
  // Studio의 동영상 목록(콘텐츠 페이지, 업로드 창이 열려 있는 동안에도 그 밑에 같이 렌더링돼
  // 있다)에서 이 업로드의 제목과 정확히 일치하는 행을 찾은 뒤, 그 행에 "업로드됨" 텍스트가
  // 뜨는지를 본다(실제 화면에서 확인한 마크업: `<div class="cell-description ...
  // ytcp-video-row">업로드됨</div>`). 그 뒤의 HD 변환/검토 같은 유튜브 서버 쪽 처리는
  // 로컬 파일과 무관하므로 이 시점에 지워도 된다.
  // 원래는 "공개 상태" 칸(.tablecell-visibility)에 설정한 공개범위 라벨이 뜨는지를 봤었는데,
  // "업로드됨" 텍스트가 훨씬 더 확실한 신호라(공개범위 설정과 무관하게 로컬 전송이 끝나면
  // 뜨는 상태 그 자체) 이 방식으로 교체했다.
  // 행을 찾을 때 처음엔 <ytcp-video-upload-progress uploading> 배지(업로드 취소 버튼)가
  // 떠 있어야만 인정했었는데, 업로드가 폴링 간격(2초)보다 빨리 끝나버리면 그 배지가 뜬
  // 순간을 놓쳐 영영 못 찾는 문제가 실제로 있었다(배지는 한 번 사라지면 다시 안 뜸). 지금은
  // 동영상 목록이 기본적으로 날짜 최신순 정렬이라는 점(헤더의 aria-sort="descending"으로
  // 확인)을 이용해, 제목이 일치하는 행 중 가장 위(=가장 최근) 행을 그대로 쓴다 — 동명의
  // 예전 영상이 있어도 방금 올린 것보다는 아래에 있어 섞이지 않는다.
  // ---------------------------------------------------------------------------
  const UPLOAD_ROW_SELECTOR = 'ytcp-video-row';
  const UPLOAD_ROW_TITLE_SELECTOR = '#video-title';
  const UPLOAD_ROW_DESCRIPTION_SELECTOR = '.cell-description';
  const UPLOAD_DONE_TEXT = '업로드됨';
  const UPLOAD_ROW_POLL_MS = 2000;
  // 이 제목의 행이 처음 나타나기를 기다리는 시간 — 화면에 반영되기까지의 지연만 감안하면
  // 되므로 길 필요는 없다. 여기서 못 찾으면(제목이 안 맞음 등) 뒤 단계로 넘어가지 않고
  // 삭제를 포기한다.
  const UPLOAD_ROW_APPEAR_TIMEOUT_MS = 3 * 60 * 1000;
  // "업로드됨" 텍스트가 뜨길 기다리는 시간 — 대용량 VOD와 느린 회선을 고려해 넉넉하게 잡는다.
  const UPLOAD_ROW_DONE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
  // "완료"를 본 뒤에도 잠깐 더 지켜봐서 일시적인 순간이 아닌지 확인한 다음에만 삭제한다.
  const UPLOAD_ROW_DONE_CONFIRM_MS = 5000;

  // 배너 자체가 document에서 떨어져 나갔는지(Studio SPA가 우리가 넣은 엘리먼트를 함께 지워
  // 버렸을 가능성) 확인하는 데 쓰는 참조 — showBanner()가 채우고, 아래 캐시된 자식 엘리먼트를
  // 건드리는 모든 함수는 그 전에 반드시 showBanner()를 한 번 불러 이 호스트가 아직
  // document에 붙어 있는지(`isConnected`) 확인/복구한다.
  let bannerHostEl = null;
  let bannerMessageEl = null;
  let folderButtonEl = null;
  // "삭제 대기 중인 파일" 접이식 패널 — 창이 너무 커져 화면을 가리지 않도록 기본은 접힌
  // 상태다. background가 vodPipeline:pendingDeletionsUpdated로 밀어주는 최신 목록을 여기
  // 저장해뒀다가, 펼침/접힘이 바뀔 때도 다시 그릴 수 있게 한다.
  let pendingDeletionsToggleEl = null;
  let pendingDeletionsListEl = null;
  let pendingDeletionsExpanded = false;
  let latestPendingDeletions = [];
  // "업로드됨"을 확인했지만 자동 삭제 설정이 꺼져 있을 때, 수동으로 그 로컬 파일을 지울 수
  // 있게 해주는 버튼 — deleteNowTarget이 지금 이 버튼이 가리키는 파일(videoId/fileOrder)이다.
  let deleteNowButtonEl = null;
  let deleteNowTarget = null;

  // 동영상 목록의 각 행 옆에 띄우는 개별 삭제 버튼들 — 배너의 삭제 버튼은 한 번에 하나(가장
  // 최근 확인된 파일)만 가리킬 수 있어, 수동 삭제 대상이 여러 개 쌓이면 나머지는 배너로는
  // 지울 방법이 없다는 한계가 있었다. rowDeleteButtons는 key(`${videoId}:${fileOrder}`) →
  // { btn } 맵으로, syncRowDeleteButtons()가 latestPendingDeletions의 manual:true 항목마다
  // Studio 목록에서 일치하는 행을 찾아 그 옆에 버튼을 띄우고 위치를 계속 맞춰준다.
  let rowButtonsHostEl = null;
  let rowButtonsShadowRoot = null;
  const rowDeleteButtons = new Map();
  let rowButtonsSyncTimer = null;

  // 이 실행이 시작되는 시점(=파일을 첨부하기 전)에 이미 이 제목과 일치하던 행의 개수 —
  // autoSaveAndClose가 "내 파일의 새 행이 실제로 생겼는지"를 판단할 때 이 값과 비교한다.
  // 반드시 파일 첨부 전에 스냅샷을 떠야 한다: Studio는 파일을 첨부하는 즉시(제목/설명을
  // 채우거나 저장을 누르기 한참 전부터) 그 제목의 행을 목록에 만들어두므로, "닫기" 버튼을
  // 누르기 직전에 스냅샷을 뜨면(예전 코드) 이미 내 파일 자신의 행이 포함된 뒤라 그 뒤로는
  // 절대 "늘어날" 수 없어 매번 타임아웃되는 버그가 있었다(실제로 파일마다 매번 "새 행이
  // 추가된 것을 확인하지 못함" 경고가 뜨는 것으로 발견됨).
  let matchingRowsAtRunStart = 0;

  // 현재 진행 중인(또는 마지막) 업로드 실행의 데이터와 상태. 같은 탭에서 새 업로드를 시작하면
  // (youtubeStudio:restart) beginRun이 이 값들을 통째로 새로 채운다.
  let currentTitle = '';
  let currentDescription = '';
  let currentOptions = DEFAULT_OPTIONS;
  let currentVideoId = null; // 업로드 확인 후 삭제 대상을 지칭하는 데만 쓰인다
  let currentFileOrder = null;
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
  // background가 새로고침 등으로 이 탭을 정리해 "지금 당장 재사용해도 되는 상태"라고 알려준
  // 경우 true — dialogEverSeen 같은 휴리스틱을 기다릴 필요 없이 곧바로 재사용 가능하다고
  // 답한다. beginRun에서 실제로 새 업로드가 시작되면 다시 false로 되돌린다.
  let explicitlyIdle = false;
  // Date.now() 기준 이 시각이 지나기 전까지는 isReusable()이 무조건 false를 돌려준다 —
  // 저장 버튼을 누른 시점부터, 완료 화면의 닫기 버튼을 찾고/누르고 새 행이 확인될 때까지
  // 다른 트리거(알람, 다른 업로드 요청)가 이 탭을 먼저 재사용해버리는 경합을 막기 위함.
  let reuseBlockedUntil = 0;
  let watchTimer = null;
  let currentRunId = 0; // 재시작 후 이전 실행의 늦은 콜백이 끼어들지 못하게 하는 세대 번호
  const saveWatchedDialogs = new WeakSet();
  // runId별 "저장" 클릭 시각 — watchUploadAndDelete가 자기 실행의 저장 시점을 알기 위함.
  const runSavedAt = new Map();

  init();

  async function init() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'youtubeStudio:init' });
    } catch (error) {
      return; // 확장 컨텍스트가 아직 준비되지 않음
    }
    // pending: 바로 채울 업로드 데이터가 있음. managed: 지금은 없지만(예: 새로고침 직후)
    // 이 탭은 background가 재사용 대상으로 관리 중 — 둘 다 아니면 우리와 무관한 탭이다.
    if (!response?.pending && !response?.managed) return;

    // 우리가 관리하는 탭에서만 background의 재사용 요청(probe/restart)에 응답한다.
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);

    if (response.pending) {
      showBanner();
      await beginRun(response);
    } else {
      // 대기열이 비어 있어 지금은 할 일이 없는 상태(새로고침으로 정리된 직후 등) — 다음
      // probe에서 바로 재사용 가능한 것으로 응답하도록 표시해둔다.
      explicitlyIdle = true;
    }
  }

  /** 새 업로드 데이터로 상태를 초기화하고 업로드 창 감시를 (다시) 시작한다. */
  async function beginRun(payload) {
    stopWatching();
    currentRunId += 1;

    currentTitle = payload.title;
    // 파일을 첨부하기 전(=Studio가 이 제목의 행을 아직 안 만들었을 시점)에 미리 스냅샷을
    // 떠둔다 — 이유는 위 matchingRowsAtRunStart 선언부 주석 참고.
    matchingRowsAtRunStart = countRowsMatchingTitle(currentTitle);
    currentDescription = payload.description;
    currentOptions = { ...DEFAULT_OPTIONS, ...(payload.options || {}) };
    currentVideoId = payload.videoId ?? null;
    currentFileOrder = payload.fileOrder ?? null;
    fileNames = Array.isArray(payload.fileNames) ? payload.fileNames : [];
    downloadSubfolder = payload.downloadSubfolder || '';
    forcePickFolder = false;
    attachStarted = false;
    attachDone = false;
    attachResult = null;
    automationStarted = false;
    runPhase = 'waiting';
    explicitlyIdle = false; // 새 업로드가 실제로 시작됐으니 더 이상 "무조건 재사용 가능"이 아니다
    reuseBlockedUntil = 0; // 이전 실행의 닫기-버튼 대기 잠금이 새 실행까지 넘어오지 않게 초기화
    hideDeleteNowButton(); // 이전 실행이 띄워둔 "지금 삭제" 버튼은 이제 무관한 파일 것이니 지운다

    console.log(`${runTag()} 업로드 실행 시작`, currentTitle, currentOptions, fileNames);
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
    if (request?.action === 'vodPipeline:pendingDeletionsUpdated') {
      renderPendingDeletions(request.deletions);
      return false;
    }
    return false;
  }

  /**
   * 이 탭에서 새 업로드를 시작해도 되는지. 자동 입력 중이거나, 업로드 창이 열려 있는데 아직
   * 저장을 누르지 않았다면(파일 선택 대기 포함) 진행 중인 작업이므로 재사용하지 않는다.
   * 업로드 창을 한 번도 못 본 탭(막 열려서 아직 창이 뜨기 전)도 안전하게 재사용하지 않는다.
   */
  function isReusable() {
    if (Date.now() < reuseBlockedUntil) return false; // 닫기 버튼 발견~클릭 후 최소 대기 중
    if (explicitlyIdle) return true;
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
      console.warn(`${runTag()} 이 탭에서 새 업로드를 시작하지 못함: ${reason}`);
      setBannerMessage(`이 탭에서 새 업로드를 시작하지 못했습니다 (${reason}). 새 탭으로 열립니다.`, true);
      return { started: false, reason };
    };

    try {
      if (!isReusable()) return { started: false, reason: '진행 중인 업로드가 있음' };

      showBanner(); // 사용자가 배너를 닫았어도 다시 보이게
      setBannerMessage('새 업로드를 시작하는 중...');

      // 이전 실행의 감시를 먼저 멈춘다 — 새로 열릴 업로드 창에 이전 데이터가 입력되면 안 된다.
      // currentRunId는 여기서 미리 올리지 않는다 — beginRun()이 실제로 새 데이터를 채우는
      // 시점에 단 한 번만 올린다(예전엔 여기서도 올리고 beginRun에서 또 올려서, 탭을
      // 재사용할 때마다 실행 번호가 1씩이 아니라 2씩 건너뛰었다 — 로그에 실행 번호를
      // 붙이면서 발견됨).
      stopWatching();

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
      console.warn(`${runTag()} 재시작 중 오류`, error);
      return failWith('오류 발생');
    }
  }

  /** 저장 후 남아 있는 완료 화면을 닫는다. 저장 전(=진행 중) 창은 isReusable이 이미 걸러낸다. */
  async function closeFinishedDialog(dialog, selector = UPLOAD_DIALOG_SELECTOR) {
    const button = await confirmFound(
      () => findFirst(dialog, DIALOG_CLOSE_BUTTON_SELECTORS) || findButtonByText(dialog, DIALOG_CLOSE_BUTTON_TEXTS)
    );
    if (button) button.click();
    return Boolean(await waitFor(() => !document.querySelector(selector), STEP_WAIT_MS));
  }

  /**
   * 상단 "만들기" 버튼을 눌러 메뉴를 연 뒤 "동영상 업로드"(#text-item-0)를 눌러 업로드 창을 연다.
   * 실패 시 어느 단계에서 막혔는지 reason으로 알려준다(Studio 화면 구조가 바뀌었을 때 원인을 바로 알 수 있게).
   */
  async function openUploadDialog() {
    const createButton = await waitForStable(() => findVisible(document, CREATE_BUTTON_SELECTORS), STEP_WAIT_MS);
    if (!createButton) return { ok: false, reason: '"만들기" 버튼을 찾지 못함' };
    createButton.click();

    // 메뉴 항목이 DOM에는 숨겨진 채로 미리 있을 수 있어, 먼저 "보이는" 항목이 나타나길 기다린다.
    // 끝내 안 보이면 같은 id의 첫 번째 요소를 그대로 누른다(콘솔에서 이 방식으로 동작 확인).
    const item =
      (await waitForStable(findUploadMenuItem, STEP_WAIT_MS)) ||
      (await confirmFound(() => document.querySelectorAll('#text-item-0')[0]));
    if (!item) {
      console.warn(`${runTag()} "동영상 업로드" 메뉴 항목을 찾지 못함. 메뉴 항목:`, listMenuItemTexts());
      return { ok: false, reason: '"만들기" 메뉴에서 "동영상 업로드" 항목을 찾지 못함' };
    }

    console.log(`${runTag()} "동영상 업로드" 메뉴 항목 클릭`, item);
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
      watchForSave(dialog, runId);
      console.log(`${runTag(runId)} 업로드 창의 제목/설명 입력칸 발견, 자동 입력 시작`);

      await runAutomation(dialog, titleBox, descriptionBox, runId);
      if (runId === currentRunId && runPhase === 'automating') runPhase = 'ready';
    }, POLL_INTERVAL_MS);
  }

  /** 사용자가 Studio의 "저장"을 누르면 이 실행을 '저장됨'으로 표시한다(재사용 가능 판단용). */
  function watchForSave(dialog, runId) {
    if (saveWatchedDialogs.has(dialog)) return;
    saveWatchedDialogs.add(dialog);
    dialog.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof Element && event.target.closest(DONE_BUTTON_SELECTOR)) {
          runPhase = 'saved';
          runSavedAt.set(runId, Date.now());
          console.log(`${runTag(runId)} 저장 클릭 감지`);
        }
      },
      true
    );
  }

  /**
   * runId 자신의 저장 클릭 시각으로부터 MIN_DELAY_AFTER_SAVE_MS가 지날 때까지 기다린다.
   * 저장이 감지되지 않은 채 OWN_SAVE_WAIT_TIMEOUT_MS가 지나면 포기한다(자동화 실패 등).
   */
  async function waitForOwnSaveThenDelay(runId) {
    const savedAt = await waitFor(() => runSavedAt.get(runId) ?? null, OWN_SAVE_WAIT_TIMEOUT_MS, 1000);
    if (savedAt == null) return false;
    const remaining = MIN_DELAY_AFTER_SAVE_MS - (Date.now() - savedAt);
    if (remaining > 0) await sleep(remaining);
    return true;
  }

  async function runAutomation(dialog, titleBox, descriptionBox, runId) {
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
      results.push(await safely('아동용이 아닙니다', () => selectNotForKids(dialog), runId));
      report();
    }

    if (options.playlists.length > 0) {
      setBannerMessage(formatResults(results, false) + '\n재생목록 선택 중...');
      results.push(await safely('재생목록', () => selectPlaylists(dialog, options.playlists), runId));
      report();
    }

    const visibilityLabel = VISIBILITY_LABELS[options.visibility] || options.visibility;
    setBannerMessage(formatResults(results, false) + `\n공개 범위(${visibilityLabel}) 선택 중...`);
    results.push(await safely(`공개 범위(${visibilityLabel})`, () => selectVisibility(dialog, options.visibility), runId));

    const allOk = results.every((r) => r.ok);
    console.log(`${runTag(runId)} 자동 입력 결과`, results);

    if (allOk) {
      setBannerMessage(formatResults(results, true) + '\n모든 항목 입력 완료. 저장하는 중...');
      await autoSaveAndClose(dialog, runId, results);
    } else {
      setBannerMessage(
        formatResults(results, true) + '\n실패한 항목은 Studio에서 직접 설정해주세요.',
        true
      );
    }
  }

  /**
   * 모든 자동 입력이 성공했을 때만 호출된다. Studio의 "저장"(#done-button)을 직접 눌러
   * 업로드를 마무리하고, 저장 후 뜨는 완료/공유 팝업의 닫기 버튼도 자동으로 누른다.
   * 두 버튼 모두 실제 Studio 화면에서 확인한 값이 아니라 기존 코드에 있던 값을 그대로
   * 쓴 것이라, 실패하면 배너/콘솔에 어느 단계인지 남기고 사용자가 직접 마무리하게 둔다
   * (재시작으로 이 실행이 무효가 됐으면 runId 불일치로 중간에 멈춘다).
   */
  async function autoSaveAndClose(dialog, runId, results) {
    // 이 실행이 시작될 때(파일 첨부 전) 떠둔 스냅샷을 지금 여기서 값으로 캡처해둔다 —
    // 아래 여러 await를 거치는 동안 탭이 재사용돼 matchingRowsAtRunStart(모듈 변수)가
    // 다음 실행 값으로 덮어써져도 이 실행의 판단에는 영향이 없도록.
    const matchingRowsBeforeThisRun = matchingRowsAtRunStart;
    const saveButton = await confirmFound(() => dialog.querySelector(DONE_BUTTON_SELECTOR));
    if (!saveButton) {
      console.warn(`${runTag(runId)} 저장 버튼(${DONE_BUTTON_SELECTOR})을 찾지 못함`);
      setBannerMessage(formatResults(results, true) + '\n저장 버튼을 찾지 못해 직접 눌러야 합니다.', true);
      return;
    }
    if (runId !== currentRunId) return; // confirmFound가 기다리는 사이 새 업로드로 재시작됨

    console.log(`${runTag(runId)} 저장 버튼 자동 클릭`);
    // 저장을 누른 시점부터 이 탭을 무조건 재사용 금지로 잠가둔다 — 아래에서 새 행이
    // 실제로 확인될 때까지 다른 트리거(알람, 다른 업로드 요청)가 먼저 재사용해버리는
    // 경합을 막기 위함(확인되면 맨 아래에서 풀어준다).
    reuseBlockedUntil = Infinity;
    saveButton.click(); // watchForSave의 클릭 리스너가 이 클릭도 그대로 감지해 runPhase를 'saved'로 바꾼다

    // 저장 처리 중엔 원래 업로드 창이 완료 화면으로 바뀌거나, 별도의 공유 창이 뜬다.
    // 처리에 걸리는 시간이 일정하지 않아, 고정 대기 대신 닫기 버튼이 나타날 때까지 기다린다
    // (waitForStable이라 발견 즉시가 아니라 1초 뒤에도 여전히 있는 걸 재확인한 뒤 돌려준다).
    const closeButton = await waitForStable(findSaveCompletionCloseButton, SAVE_PROCESSING_TIMEOUT_MS);
    if (runId !== currentRunId) return; // 그 사이 새 업로드로 재시작됨

    if (!closeButton) {
      console.warn(`${runTag(runId)} 저장 후 완료 화면의 닫기 버튼을 찾지 못함`);
      setBannerMessage(formatResults(results, true) + '\n저장은 됐지만 완료 화면을 찾지 못했습니다. 직접 닫아주세요.', true);
      return;
    }

    console.log(`${runTag(runId)} 완료 화면 닫기 버튼 자동 클릭`);
    closeButton.click();

    // 팝업을 감싸는 컨테이너를 특정하지 않으므로, "닫기" 버튼 자체가 사라졌는지로 성공 여부를 본다.
    const popupGone = await waitFor(() => !findSaveCompletionCloseButton(), STEP_WAIT_MS);
    if (runId !== currentRunId) return;

    setBannerMessage(
      formatResults(results, true) + (popupGone ? '\n저장하고 팝업까지 자동으로 닫았습니다.' : '\n저장은 됐지만 팝업이 남아 있습니다. 직접 닫아주세요.'),
      !popupGone
    );

    // 고정 시간을 기다리는 대신, 이 파일에 해당하는 새 행이 동영상 목록에 실제로 추가된
    // 것을 확인한 뒤에야 이 탭을 다음 업로드에 내준다 — 목록이 실제로 갱신됐다는 증거를
    // 보고 판단하는 것이 임의의 대기 시간보다 안전하다. 끝내 확인되지 않아도(제목 불일치,
    // 화면 구조 변경 등) 이 탭을 영원히 막아두지는 않고 타임아웃 후 재사용을 허용한다.
    const rowAppeared = await waitFor(
      () => (countRowsMatchingTitle(currentTitle) > matchingRowsBeforeThisRun ? true : null),
      UPLOAD_ROW_APPEAR_TIMEOUT_MS,
      UPLOAD_ROW_POLL_MS
    );
    if (runId !== currentRunId) return;
    if (!rowAppeared) {
      console.warn(`${runTag(runId)} 저장 후 동영상 목록에 새 행이 추가된 것을 확인하지 못함(제목: ${currentTitle}) — 그래도 재사용은 허용함`);
    }
    reuseBlockedUntil = Date.now();

    // 저장이 끝나 이 탭이 다시 idle해졌다는 신호 — 대기열에 다음 업로드가 있으면 background가
    // 다음 알람/요청까지 기다리지 않고 바로 이어서 재사용을 시도할 수 있다.
    notifyBecameIdle();
  }

  function notifyBecameIdle() {
    chrome.runtime.sendMessage({ action: 'youtubeStudio:becameIdle' }).catch(() => {});
  }

  /**
   * 저장 후 나타나는 완료/공유 화면의 닫기 버튼을 찾는다. 그 화면을 감싸는 요소가
   * `ytcp-uploads-dialog`나 `ytcp-video-share-dialog`가 아닐 수도 있어(확인 안 된 추측),
   * 특정 컨테이너 안으로 좁히지 않고 화면 전체에서 실제로 보이는 버튼을 찾는다 — "닫기"
   * 버튼은 저장 직후 이 시점에만 나타나므로 범위를 넓혀도 엉뚱한 버튼을 누를 위험은 적다.
   */
  function findSaveCompletionCloseButton() {
    return findVisible(document, DIALOG_CLOSE_BUTTON_SELECTORS) || findVisibleButtonByText(document, DIALOG_CLOSE_BUTTON_TEXTS);
  }

  function findVisibleButtonByText(root, texts) {
    const wanted = texts.map(normalize);
    return (
      Array.from(root.querySelectorAll('ytcp-button, button')).find(
        (btn) => isVisible(btn) && wanted.includes(normalize(btn.textContent))
      ) || null
    );
  }

  function formatResults(results, includeDetail) {
    return results
      .map((r) => `${r.ok ? '✓' : '✗'} ${r.label}${includeDetail && r.detail ? ` (${r.detail})` : ''}`)
      .join('\n');
  }

  async function safely(label, step, runId = currentRunId) {
    try {
      const outcome = await step();
      return { label, ok: outcome.ok, detail: outcome.detail };
    } catch (error) {
      console.warn(`${runTag(runId)} ${label} 단계 오류:`, error);
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
      console.warn(`${runTag()} 저장된 폴더 핸들을 불러오지 못함`, error);
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
    showBanner(); // 배너가 document에서 떨어져 나갔으면 복구
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
        console.warn(`${runTag()} 폴더 연결 실패`, error);
        setBannerMessage(`폴더 연결 실패: ${error.message}`, true);
      }
      return;
    }

    if (!attachDone) attachStarted = false; // 새 폴더/권한으로 다시 시도
    await refreshFolderButton();
    tryAttach();
  }

  /**
   * "업로드됨"을 확인했지만 자동 삭제 설정(deleteAfterUpload)이 꺼져 있어서
   * watchUploadAndDelete가 삭제를 시도하지 않은 파일을, 사용자가 원하면 바로 지울 수
   * 있게 배너에 버튼을 띄운다. 새 실행이 시작되면(beginRun) 이 파일과 무관해지므로
   * hideDeleteNowButton으로 지운다.
   */
  function offerManualDelete(videoId, fileOrder, title) {
    showBanner(); // 배너가 document에서 떨어져 나갔으면 복구(콘솔에는 확인 로그가 찍히는데 버튼이 안 보이던 문제)
    if (!deleteNowButtonEl) return; // 배너 생성 자체가 실패한 극단적인 경우만 무시
    deleteNowTarget = { videoId, fileOrder, title };
    deleteNowButtonEl.hidden = false;
    deleteNowButtonEl.disabled = false;
    deleteNowButtonEl.textContent = '🗑 지금 로컬 파일 삭제';
  }

  function hideDeleteNowButton() {
    // 새 실행이 시작될 때 이 탭의 버튼만 숨긴다 — 아직 지우지 않은 이전 파일은 여전히
    // "삭제 대기 중" 목록(패널)에 남아 있어야 하므로 여기서 pending:false를 보내지 않는다.
    deleteNowTarget = null;
    if (deleteNowButtonEl) deleteNowButtonEl.hidden = true;
  }

  async function onDeleteNowButtonClick() {
    if (!deleteNowTarget || deleteNowButtonEl.disabled) return;
    const { videoId, fileOrder, title } = deleteNowTarget;
    deleteNowButtonEl.disabled = true;
    deleteNowButtonEl.textContent = '삭제하는 중...';
    try {
      const response = await chrome.runtime.sendMessage({ action: 'download:deleteUploaded', videoId, fileOrder });
      if (response?.success) {
        console.log(`${runTag()} 수동으로 로컬 파일 삭제됨: ${response.name || ''}`);
        deleteNowButtonEl.textContent = `✓ 삭제됨${response.name ? ` (${response.name})` : ''}`;
        notifyPendingDeletion(videoId, fileOrder, title, false, true); // 패널의 "삭제 대기" 목록에서 내림
      } else {
        console.warn(`${runTag()} 수동 삭제 실패: ${response?.error}`);
        deleteNowButtonEl.textContent = `✗ 삭제 실패(${response?.error || '알 수 없는 오류'}) — 다시 시도`;
        deleteNowButtonEl.disabled = false;
      }
    } catch (error) {
      console.warn(`${runTag()} 수동 삭제 요청 오류`, error);
      deleteNowButtonEl.textContent = '✗ 삭제 요청 오류 — 다시 시도';
      deleteNowButtonEl.disabled = false;
    }
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

      // 업로드 확인 감시는 우리가 자동으로 첨부한 파일임이 확실할 때만 시도한다 — 사용자가
      // 직접 다른 파일을 골랐다면(attachResult.ok가 아니었다면) 어느 로컬 파일이 실제로
      // 올라갔는지 알 수 없어 절대 건드리지 않는다. 삭제 설정(deleteAfterUpload)과
      // 무관하게 항상 감시한다 — 예전엔 deleteAfterUpload와 pipeline이 둘 다 꺼져 있으면
      // 이 감시 자체가 시작되지 않아, "자동 삭제 확인 후 수동 삭제" 버튼(watchUploadAndDelete
      // 안의 offerManualDelete)이 일반 수동 업로드에서는 영원히 뜨지 않는 실제 버그였다
      // (다시보기 파이프라인을 켰을 때만 우연히 동작했음). 삭제 설정이 꺼져 있으면
      // watchUploadAndDelete 내부에서 자동 삭제 대신 수동 삭제 버튼 제공 + 패널 표시만 한다.
      if (currentVideoId != null && currentFileOrder != null) {
        watchUploadAndDelete(runId, currentTitle, currentOptions.deleteAfterUpload);
      }
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

  /**
   * 로컬 파일 전송까지 끝난 것을 확인한 뒤, background에 그 사실을 알리고(다시보기
   * 파이프라인이 다음 다시보기로 넘어갈지 판단하는 근거) — 삭제 설정이 켜져 있으면 그
   * 확인된 파일의 삭제도 요청한다. 확인하지 못하면(제목이 안 맞음, 시간 초과 등) 그냥
   * 아무것도 하지 않는다 — 삭제도, 확인 알림도 절대 낙관적으로 하지 않는다. 재시작으로
   * 실행이 바뀌어도(runId 불일치) 이 감시 자체는 끝까지 계속된다(아래 주석 참고).
   */
  async function watchUploadAndDelete(runId, title, shouldDelete) {
    const videoId = currentVideoId;
    const fileOrder = currentFileOrder;
    const tag = runTag(runId);

    // 자동 삭제 대상 파일을 "삭제 대기 중"(자동)으로 background에 알린다 — 파이프라인이 이
    // 개수가 너무 쌓이면(디스크 공간 위험) 배치를 잠깐 멈추는 데 쓰고, Studio 패널에도 목록으로
    // 보여준다. 함수가 어떻게 끝나든(성공/실패/시간 초과) 반드시 짝을 맞춰 false로 알린다.
    // 자동 삭제가 꺼진 경우(수동 삭제 대상)는 여기서 미리 알리지 않는다 — "업로드됨"이
    // 확인되기 전까지는 아직 지울 필요가 있는 파일인지 자체를 모르기 때문에, 확인된
    // 시점(아래 !shouldDelete 분기)에서 별도로 manual:true로 알린다.
    if (shouldDelete) notifyPendingDeletion(videoId, fileOrder, title, true, false);

    try {
      // 저장을 누른 직후에는 목록에 남아있던 동일 제목의 옛 행(이전 시도, 재업로드 등)을
      // 새 업로드로 착각해 즉시 "확인됨"으로 판단하는 사고가 실제로 의심됐다. 이 실행이
      // 저장을 누른 시점을 확실히 잡고 그로부터 최소 1분은 지난 뒤에야 목록 확인을
      // 시작해, 새 행이 실제로 만들어질 시간을 확보한다.
      const saved = await waitForOwnSaveThenDelay(runId);
      if (!saved) {
        console.log(`${tag} 저장 클릭을 확인하지 못해 업로드 확인을 시작하지 않음`);
        return;
      }

      // 주의: 탭이 재사용돼(youtubeStudio:restart) 이 사이에 새 업로드가 시작되면 currentRunId가
      // 바뀌지만, 이 감시는 그것과 무관하게 끝까지 계속돼야 한다 — 이전 업로드의 로컬 전송이
      // 저장 버튼을 누른 뒤에도 한참 더 걸릴 수 있는데, 여기서 포기하면 그 파일은 영영 확인이
      // 안 된다(실제로 발견된 문제: 탭 재사용 시 이전 업로드 완료 검사가 씹혔었음).
      // videoId/fileOrder/title/shouldDelete는 이미 위에서 값으로 캡처해뒀으니 이후 전역
      // 상태가 바뀌어도 안전하다.
      const done = await waitForLocalUploadDone(tag, title);

      if (!done) {
        console.log(`${tag} 로컬 업로드 완료를 확인하지 못함`);
        return;
      }

      // 다시보기 파이프라인이 듣고 있으면(파이프라인이 아니어도 무해함 — background가 그냥
      // 무시한다) 이 파일의 업로드가 확인됐다고 알린다. 삭제 성공/실패와 무관하게 "업로드
      // 확인"은 이미 끝난 사실이라 먼저 보낸다.
      chrome.runtime.sendMessage({ action: 'vodPipeline:fileConfirmed', videoId, fileOrder }).catch(() => {});

      const showBannerForThis = runId === currentRunId; // 재사용으로 이미 새 실행이 시작됐다면 배너를 덮어쓰지 않는다
      if (!shouldDelete) {
        console.log(`${tag} 업로드 확인됨(삭제 설정 꺼짐)`);
        // 자동으로는 지우지 않지만, 사용자가 나중에 직접 지울 수 있도록 패널의 "삭제 대기
        // 중인 파일" 목록에는 manual:true로 올려둔다 — onDeleteNowButtonClick이 실제로
        // 지운 뒤에야 pending:false로 내려간다(자동 삭제와 달리 여기서 finally를 통해
        // 자동으로 내려가지 않는다 — 아래 finally의 `if (shouldDelete)` 조건 참고).
        notifyPendingDeletion(videoId, fileOrder, title, true, true);
        if (showBannerForThis) {
          setBannerMessage('✓ 업로드가 확인됐습니다. 필요하면 아래 버튼으로 로컬 파일을 지울 수 있습니다.');
          offerManualDelete(videoId, fileOrder, title);
        }
        return;
      }

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'download:deleteUploaded',
          videoId,
          fileOrder,
        });

        if (response?.success) {
          console.log(`${tag} 업로드 확인, 로컬 파일 삭제됨: ${response.name || ''}`);
          if (showBannerForThis) setBannerMessage(`✓ 업로드 확인, 로컬 파일을 삭제했습니다. (${response.name || ''})`);
        } else {
          console.warn(`${tag} 로컬 파일 삭제 실패: ${response?.error}`);
          if (showBannerForThis) setBannerMessage(`✗ 업로드는 확인됐지만 로컬 파일 삭제 실패: ${response?.error}`, true);
        }
      } catch (error) {
        console.warn(`${tag} 로컬 파일 삭제 요청 오류`, error);
      }
    } finally {
      runSavedAt.delete(runId);
      // 자동 삭제 대상만 여기서 정리한다 — 수동 삭제 대상(shouldDelete === false)은 위
      // !shouldDelete 분기에서 이미 manual:true로 목록에 올렸고, 사용자가 실제로 버튼을
      // 눌러 지울 때(onDeleteNowButtonClick)까지 목록에 남아 있어야 하므로 여기서 내리지
      // 않는다. 저장 확인/업로드 확인에 실패해 일찍 return한 경우(이 파일에 대해 애초에
      // pending:true를 보낸 적 없는 경우)에도 shouldDelete가 true였다면 그냥 무해한
      // pending:false 알림이 한 번 더 갈 뿐이다(이미 없는 key를 지우는 건 background에서
      // no-op).
      if (shouldDelete) notifyPendingDeletion(videoId, fileOrder, title, false, false);
    }
  }

  /**
   * background에 이 파일의 "삭제 대기" 상태 변화를 알린다(자동 삭제 대상은 배치 자동
   * 일시정지 판단 + 패널 표시용, 수동 삭제 대상은 패널 표시 전용). `manual`이 true인
   * 항목은 배치 자동 일시정지 문턱 계산에서 제외된다(background.js 참고) — 사용자가
   * 버튼을 언제 누를지 알 수 없는데 그걸로 파이프라인을 멈춰두면 무한정 멈출 수 있어서다.
   */
  function notifyPendingDeletion(videoId, fileOrder, title, pending, manual) {
    chrome.runtime.sendMessage({ action: 'vodPipeline:deletionPendingChanged', videoId, fileOrder, title, pending, manual }).catch(() => {});
  }

  /**
   * 목록 행 옆 개별 삭제 버튼들을 띄우는 별도의 top-level shadow DOM 호스트를 만든다(배너와
   * 같은 방식 — showBanner() 참고). Studio의 `ytcp-video-row`는 Shadow DOM 커스텀
   * 엘리먼트로 추정되는데, 거기에 우리 버튼을 직접 자식으로 넣으면(light DOM) 대응하는
   * `<slot>`이 없을 경우 아예 렌더링되지 않을 위험이 있다(미검증). 그래서 행에 실제로 끼워
   * 넣지 않고, 이 별도 호스트 안에 `position: fixed` 버튼을 두고 `getBoundingClientRect()`로
   * 위치만 그 행을 따라가게 한다 — Studio의 내부 렌더링 구조와 완전히 무관하게 항상 화면에
   * 보장된다. 배너와 마찬가지로 document에서 떨어져 나갔으면(`isConnected` 확인) 다시 만든다.
   */
  function ensureRowButtonsHost() {
    if (rowButtonsHostEl && rowButtonsHostEl.isConnected) return;

    document.getElementById(ROW_BUTTON_HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = ROW_BUTTON_HOST_ID;
    host.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646;';
    document.documentElement.appendChild(host);
    rowButtonsHostEl = host;

    rowButtonsShadowRoot = host.attachShadow({ mode: 'open' });
    rowButtonsShadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .row-delete {
          position: fixed;
          width: 26px;
          height: 26px;
          border: 0;
          border-radius: 50%;
          background: #dc2626;
          color: #fff;
          font: 13px/26px Arial, sans-serif;
          text-align: center;
          padding: 0;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0,0,0,.35);
        }
        .row-delete:hover:not(:disabled) { background: #b91c1c; }
        .row-delete:disabled { opacity: .6; cursor: default; }
      </style>
    `;
    // 이전(떨어져 나간) shadow DOM 소속 버튼들은 더 이상 화면에 없다 — 맵을 비워 다음
    // syncRowDeleteButtons() 호출에서 새로 만들게 한다.
    rowDeleteButtons.clear();
  }

  function startRowButtonsSync() {
    if (rowButtonsSyncTimer) return;
    rowButtonsSyncTimer = setInterval(syncRowDeleteButtons, ROW_BUTTON_SYNC_INTERVAL_MS);
  }

  function stopRowButtonsSync() {
    if (!rowButtonsSyncTimer) return;
    clearInterval(rowButtonsSyncTimer);
    rowButtonsSyncTimer = null;
  }

  /**
   * latestPendingDeletions의 manual:true(수동 삭제 필요) 항목마다 Studio 목록에서 제목이
   * 일치하는 행을 찾아 그 옆에 삭제 버튼을 띄우거나 위치를 갱신한다. 행이 지금 화면에
   * 없으면(스크롤 밖, 가상화 등) 버튼을 지우지 않고 숨기기만 한다 — 다시 스크롤해서
   * 나타나면 같은 버튼을 재사용해 이어서 보여준다. manual 대상이 하나도 없으면 버튼을 모두
   * 치우고 주기적 재동기화도 멈춘다(불필요한 폴링 방지).
   */
  function syncRowDeleteButtons() {
    const manualEntries = latestPendingDeletions.filter((d) => d.manual);

    if (manualEntries.length === 0) {
      for (const { btn } of rowDeleteButtons.values()) btn.remove();
      rowDeleteButtons.clear();
      stopRowButtonsSync();
      return;
    }

    ensureRowButtonsHost();
    const seenKeys = new Set();

    for (const entry of manualEntries) {
      seenKeys.add(entry.key);
      const row = findRowByTitle(entry.title);
      let record = rowDeleteButtons.get(entry.key);

      if (!row) {
        if (record) record.btn.style.display = 'none';
        continue;
      }

      if (!record) {
        const btn = document.createElement('button');
        btn.className = 'row-delete';
        btn.type = 'button';
        btn.title = '이 파일의 로컬 사본 삭제';
        btn.textContent = '🗑';
        btn.addEventListener('click', () => onRowDeleteButtonClick(entry, btn));
        rowButtonsShadowRoot.appendChild(btn);
        record = { btn };
        rowDeleteButtons.set(entry.key, record);
      }

      const rect = row.getBoundingClientRect();
      record.btn.style.display = '';
      record.btn.style.top = `${Math.round(rect.top + rect.height / 2 - 13)}px`;
      record.btn.style.left = `${Math.round(rect.right - 34)}px`;
    }

    // 더 이상 manual 목록에 없는(삭제 완료 또는 다른 이유로 빠진) 항목의 버튼은 정리한다.
    for (const [key, record] of rowDeleteButtons) {
      if (!seenKeys.has(key)) {
        record.btn.remove();
        rowDeleteButtons.delete(key);
      }
    }

    startRowButtonsSync();
  }

  /** 목록 행 옆 버튼을 눌렀을 때 — 배너의 onDeleteNowButtonClick과 같은 요청을 보내지만,
   *  버튼 하나짜리 좁은 공간에 맞춰 텍스트 대신 아이콘만 바꿔 상태를 보여준다. */
  async function onRowDeleteButtonClick(entry, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'download:deleteUploaded',
        videoId: entry.videoId,
        fileOrder: entry.fileOrder,
      });
      if (response?.success) {
        console.log(`${runTag()} 목록 행 버튼으로 로컬 파일 삭제됨: ${response.name || ''}`);
        notifyPendingDeletion(entry.videoId, entry.fileOrder, entry.title, false, true);
        btn.remove();
        rowDeleteButtons.delete(entry.key);
      } else {
        console.warn(`${runTag()} 목록 행 버튼 삭제 실패: ${response?.error}`);
        btn.disabled = false;
        btn.textContent = '✗';
        setTimeout(() => {
          btn.textContent = '🗑';
        }, 2000);
      }
    } catch (error) {
      console.warn(`${runTag()} 목록 행 버튼 삭제 요청 오류`, error);
      btn.disabled = false;
      btn.textContent = '✗';
      setTimeout(() => {
        btn.textContent = '🗑';
      }, 2000);
    }
  }

  /**
   * 동영상 목록에서 이 업로드에 해당하는 행을 찾아, 그 행에 "업로드됨" 텍스트가 뜨는지를
   * 본다. 행을 찾을 때 "업로드 중" 배지가 떠 있어야 한다는 조건을 걸었었는데, 업로드가
   * 우리 폴링 간격(2초)보다 빨리 끝나버리면 그 배지가 뜬 순간을 놓쳐서 영영 못 찾는 문제가
   * 실제로 있었다(배지는 한 번 사라지면 다시 안 뜸). 대신 동영상 목록이 기본적으로 날짜
   * 최신순으로 정렬돼 있다는 점을 이용해, 제목이 일치하는 행 중 **가장 위(=DOM에 가장
   * 먼저 나오는, 가장 최근에 올라간)** 행을 그대로 쓴다 — 동명의 예전 영상이 있어도 방금
   * 올린 것보다는 아래에 있어 섞이지 않는다. "업로드됨" 텍스트가 뜬 뒤에도 잠깐 더
   * 지켜봐서 안정적인지 확인한다. 탭 재사용으로 새 실행이 시작돼도(runId가 바뀌어도) 이
   * 감시 자체는 멈추지 않는다 — watchUploadAndDelete의 주석 참고.
   */
  async function waitForLocalUploadDone(tag, title) {
    let row = null;
    const appeared = await waitFor(
      () => {
        row = findRowByTitle(title);
        return row ? true : null;
      },
      UPLOAD_ROW_APPEAR_TIMEOUT_MS,
      UPLOAD_ROW_POLL_MS
    );
    if (!appeared || !row) {
      console.log(`${tag} 동영상 목록에서 이 제목의 행을 찾지 못함(제목: ${title})`);
      return false;
    }

    const doneOnce = await waitFor(
      () => (isUploadMarkedDone(row) ? true : null),
      UPLOAD_ROW_DONE_TIMEOUT_MS,
      UPLOAD_ROW_POLL_MS
    );
    if (!doneOnce) return false;

    await sleep(UPLOAD_ROW_DONE_CONFIRM_MS);
    return isUploadMarkedDone(row);
  }

  /** 동영상 목록에서 제목이 정확히 일치하는 행 중 가장 위(=최신순 정렬 기준 가장 최근) 행. */
  function findRowByTitle(title) {
    const target = normalize(title);
    const rows = document.querySelectorAll(UPLOAD_ROW_SELECTOR);
    for (const row of rows) {
      const titleEl = row.querySelector(UPLOAD_ROW_TITLE_SELECTOR);
      if (!titleEl) continue;
      const label = normalize(titleEl.getAttribute('aria-label') || titleEl.textContent);
      if (label === target) return row;
    }
    return null;
  }

  /**
   * 제목이 정확히 일치하는 행의 개수. 저장 직후 "새 행이 실제로 추가됐는지"를 확인할 때는
   * findRowByTitle처럼 하나라도 있는지만 보면 안 된다 — 같은 제목으로 예전에 이미 올려둔
   * 영상이 있으면 새 행이 아직 안 생겼는데도 그 옛 행만 보고 "확인됨"으로 오판할 수 있다.
   * 저장 전 개수와 비교해 실제로 "늘었는지"를 봐야 안전하다.
   */
  function countRowsMatchingTitle(title) {
    const target = normalize(title);
    let count = 0;
    for (const row of document.querySelectorAll(UPLOAD_ROW_SELECTOR)) {
      const titleEl = row.querySelector(UPLOAD_ROW_TITLE_SELECTOR);
      if (!titleEl) continue;
      const label = normalize(titleEl.getAttribute('aria-label') || titleEl.textContent);
      if (label === target) count += 1;
    }
    return count;
  }

  /**
   * 이 행에 "업로드됨" 텍스트가 실제로 "보이는" 상태로 표시됐는지(부분 일치 없이 정확히
   * 일치해야 한다). `row.querySelector(...).textContent`를 그대로 믿지 않고 **화면에
   * 보이는** 요소인지까지 확인하는 이유: Studio 화면 다른 곳(재생목록 팝업 등)에서 이미
   * 확인된 패턴처럼, 상태별 텍스트를 미리 다 만들어두고 실제 상태에 따라 display만 켜고
   * 끄는 방식일 가능성이 있다(확인 안 됨 — 다만 "삭제하면 안 될 시점에 삭제된다"는 제보와
   * 맞아떨어진다: 그렇다면 아직 활성화 안 된 "업로드됨" 텍스트가 DOM/textContent에는 이미
   * 존재해서, 화면에 보이는지 확인하지 않고 querySelector 하나만 믿으면 실제로는 아직
   * "업로드됨"이 아닌데도 그렇다고 오판할 수 있다). 그래서 `.cell-description`에 해당하는
   * 요소를 전부 찾아, 그중 실제로 보이는(`isVisible`) 것만 대상으로 텍스트를 비교한다 —
   * 후보가 하나뿐이고 항상 보이는 상황이라면 기존과 동작이 같다.
   */
  function isUploadMarkedDone(row) {
    for (const cell of row.querySelectorAll(UPLOAD_ROW_DESCRIPTION_SELECTOR)) {
      if (!isVisible(cell)) continue;
      if (normalize(cell.textContent) === UPLOAD_DONE_TEXT) return true;
    }
    return false;
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

    // 목록을 불러오기 전에 체크를 시도하면 전부 "못 찾음"이 되므로, 행이 나타나고 개수가
    // 안정될 때까지 기다린다.
    const loaded = await waitForPlaylistRows(popup);
    if (!loaded) {
      const giveUpButton = await confirmFound(() => findFirst(popup, PLAYLIST_DONE_SELECTORS));
      giveUpButton?.click();
      return { ok: false, detail: '재생목록이 불러와지지 않음' };
    }

    const missing = [];
    for (const name of names) {
      // 이미 다 불러왔다면 바로 찾고, 늦게 도착하는 항목이 있을 수 있어 못 찾으면 잠깐 더 기다린다.
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

    if (missing.length > 0) {
      return { ok: false, detail: `못 찾음/선택 실패: ${missing.join(', ')}` };
    }
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
      // 단계 표시를 못 누르면 "다음" 버튼으로 세 단계를 넘어간다.
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

  /**
   * getter()가 지금 당장 참이면 CONFIRM_GAP_MS만큼 기다린 뒤 다시 한 번 확인해서, 그때도
   * 참이어야 그 값을(재확인 시점의 최신 참조로) 돌려준다 — Studio가 화면을 다시 그리는
   * 도중 우연히 한 순간만 조건에 맞아 보이는 엘리먼트를 성급하게 클릭하는 사고를 막기
   * 위함. 처음부터 거짓이면 기다리지 않고 그대로 null(폴백으로 바로 넘어갈 수 있게).
   * Studio에서 무언가를 클릭하기 전에는 항상 이 함수(또는 이를 쓰는 waitForStable)를
   * 거쳐서 얻은 엘리먼트만 누른다.
   */
  async function confirmFound(getter, confirmGapMs = CONFIRM_GAP_MS) {
    const first = getter();
    if (!first) return null;
    await sleep(confirmGapMs);
    return getter() || null;
  }

  /**
   * waitFor처럼 timeoutMs 안에서 폴링하되, "찾았다"고 바로 반환하지 않고 confirmFound로
   * CONFIRM_GAP_MS 뒤 다시 확인해서 그때도 참이어야 반환한다. 첫 확인 뒤 사라졌다면(아직
   * 불안정한 상태) 포기하지 않고 남은 시간 동안 계속 폴링한다.
   */
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

  /**
   * 배너를 만든다 — 이미 만들어져 있고 여전히 document에 붙어 있으면 아무것도 하지 않는다.
   * `bannerHostEl.isConnected`로 확인하는 이유: Studio 페이지에서 우리가 넣은 엘리먼트가
   * (원인은 확인되지 않았지만) 문서에서 떨어져 나가는 것으로 의심되는 사례가 보고됐다 —
   * 콘솔 로그(예: "업로드 확인됨")는 정상적으로 찍히는데 배너/버튼이 화면에 전혀 안 보이는
   * 증상이었다. `document.getElementById(BANNER_HOST_ID)`만 확인하면 같은 id를 가진 고아
   * 엘리먼트가 남아있는 극단적인 경우를 걸러내지 못할 수 있어, 실제 연결 참조
   * (`bannerHostEl`)의 `isConnected`를 직접 확인한다. 배너 상태를 바꾸는 모든 함수
   * (setBannerMessage, offerManualDelete, hideDeleteNowButton, renderPendingDeletions,
   * refreshFolderButton)는 캐시된 자식 엘리먼트를 만지기 전에 반드시 이 함수를 먼저 불러
   * 떨어져 나갔으면 여기서 다시 만들어 붙인다.
   */
  function showBanner() {
    if (bannerHostEl && bannerHostEl.isConnected) return;

    // 혹시 같은 id의 고아 엘리먼트가 document 어딘가에 남아 있다면(이론상으로만 가능) id
    // 충돌을 피하기 위해 먼저 치운다.
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
        .delete-now { width: 100%; margin-top: 6px; padding: 7px; border: 0; border-radius: 5px; background: #dc2626; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .delete-now:hover:not(:disabled) { background: #b91c1c; }
        .delete-now:disabled { opacity: .6; cursor: default; }
        .delete-now[hidden] { display: none; }
        .pending-deletions { margin-top: 8px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
        .pending-toggle { display: block; width: 100%; text-align: left; padding: 2px 0; border: 0; background: transparent; color: #374151; cursor: pointer; font-size: 12px; font-weight: 600; }
        .pending-toggle:hover { color: #2563eb; }
        .pending-list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
        .pending-list[hidden] { display: none; }
        .pending-list li { font-size: 11px; color: #4b5563; padding: 4px 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; word-break: break-all; }
      </style>
      <div class="banner">
        <div class="top"><strong>🎬 VOD 업로드 도우미</strong><button class="close" id="close" title="닫기">×</button></div>
        <p class="message" id="message"></p>
        <div class="actions">
          <button class="copy" id="copyTitle">제목 복사</button>
          <button class="copy" id="copyDescription">설명 복사</button>
        </div>
        <button class="folder" id="folderButton" hidden></button>
        <button class="delete-now" id="deleteNowButton" hidden></button>
        <div class="pending-deletions">
          <button class="pending-toggle" id="pendingToggle" type="button">▶ 삭제 대기 중인 파일 (0개)</button>
          <ul class="pending-list" id="pendingList" hidden></ul>
        </div>
      </div>`;

    bannerMessageEl = shadowRoot.getElementById('message');
    folderButtonEl = shadowRoot.getElementById('folderButton');
    folderButtonEl.addEventListener('click', onFolderButtonClick);

    deleteNowButtonEl = shadowRoot.getElementById('deleteNowButton');
    deleteNowButtonEl.addEventListener('click', onDeleteNowButtonClick);

    pendingDeletionsToggleEl = shadowRoot.getElementById('pendingToggle');
    pendingDeletionsListEl = shadowRoot.getElementById('pendingList');
    pendingDeletionsToggleEl.addEventListener('click', () => {
      pendingDeletionsExpanded = !pendingDeletionsExpanded;
      renderPendingDeletions(latestPendingDeletions);
    });
    // 배너가 새로 만들어질 때마다(탭이 재사용돼도 한 번만 만들어짐) 지금까지의 삭제 대기
    // 목록을 background에 물어 초기 상태를 채운다 — 이후는 push되는 업데이트로 갱신된다.
    chrome.runtime
      .sendMessage({ action: 'vodPipeline:getPendingDeletions' })
      .then((res) => { if (res?.success) renderPendingDeletions(res.deletions); })
      .catch(() => {});
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

  /**
   * "삭제 대기 중인 파일" 패널을 다시 그린다. 목록이 길어져 창이 화면을 가리는 일이 없도록
   * 기본은 접혀 있고(pendingDeletionsExpanded), 토글 버튼을 눌러야 펼쳐진다 — 펼쳐도 목록
   * 자체가 스크롤(max-height)돼 무한정 커지지는 않는다. 이 함수가 불린다는 것 자체가 이미
   * background가 이 탭을 관리 대상 Studio 탭으로 보고 있다는 뜻이므로(getStudioTabId()),
   * showBanner()로 배너가 document에서 떨어져 나갔으면 복구한 뒤 그린다.
   */
  function renderPendingDeletions(list) {
    latestPendingDeletions = Array.isArray(list) ? list : [];
    syncRowDeleteButtons(); // 배너 패널과 별개로, 목록 행 옆 개별 삭제 버튼도 최신 상태로 맞춘다
    showBanner();
    if (!pendingDeletionsToggleEl || !pendingDeletionsListEl) return;

    const arrow = pendingDeletionsExpanded ? '▼' : '▶';
    pendingDeletionsToggleEl.textContent = `${arrow} 삭제 대기 중인 파일 (${latestPendingDeletions.length}개)`;
    pendingDeletionsListEl.hidden = !pendingDeletionsExpanded;

    pendingDeletionsListEl.textContent = '';
    const sorted = [...latestPendingDeletions].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    if (sorted.length === 0) {
      const li = document.createElement('li');
      li.textContent = '없음';
      pendingDeletionsListEl.appendChild(li);
      return;
    }
    for (const item of sorted) {
      const li = document.createElement('li');
      const label = item.title || `${item.videoId} (${item.fileOrder}번)`;
      li.textContent = item.manual ? `${label} (수동 삭제 필요)` : label;
      pendingDeletionsListEl.appendChild(li);
    }
  }

  function setBannerMessage(text, isError = false) {
    showBanner(); // 배너가 document에서 떨어져 나갔으면 복구
    if (!bannerMessageEl) return;
    bannerMessageEl.textContent = text;
    bannerMessageEl.classList.toggle('error', isError);
  }
})();
