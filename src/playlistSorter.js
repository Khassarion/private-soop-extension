import { parseTitleDate, parseBroadcastStart } from './youtubeMatch.js';

const els = {
  playlistSelect: document.getElementById('playlistSelect'),
  phraseInput: document.getElementById('phraseInput'),
  loadBtn: document.getElementById('loadBtn'),
  loadPlaylistsBtn: document.getElementById('loadPlaylistsBtn'),
  checkPlaylistBtn: document.getElementById('checkPlaylistBtn'),
  autoBtn: document.getElementById('autoBtn'),
  summary: document.getElementById('summary'),
  videoList: document.getElementById('videoList'),
  videoLoadStatus: document.getElementById('videoLoadStatus'),
  playlistsLoadStatus: document.getElementById('playlistsLoadStatus'),
  playlistLoadStatus: document.getElementById('playlistLoadStatus'),
  hideInOrderCheckbox: document.getElementById('hideInOrderCheckbox'),
};

const ADD_MAX_ATTEMPTS = 5;
const ADD_RETRY_DELAY_MS = 2000;

let uploads = [];
let skippedNoDate = 0;
const statuses = new Map();
let running = false;
let stopRequested = false;
let batchHaltMessage = '';
// 자동 추가 중 지금 처리 중인 영상 — render()가 이 영상의 행을 화면에 스크롤해 보여준다.
let autoScrollTargetId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 대상 재생목록. "내 재생목록 불러오기"로 드롭다운을 채운 뒤 고른 값 — Studio가 이름+id를
// 한 번에 주므로(youtubePlaylistsList.js) 더 이상 공개 페이지에서 제목을 따로 가져올 필요가 없다.
let targetPlaylistId = '';
let targetPlaylistTitle = '';
// videoId -> 재생목록 안 순서(1부터). "재생목록 조회" 버튼을 눌러야 채워진다(영상 목록
// 불러오기와는 독립). 스크래핑 배열의 순서가 실제 재생목록 순서와 같다(DOM 등장 순서로
// 모았으므로). 추가를 시도했다가 "이미 있었음"으로 확인된 건 순서를 모르니 null.
let existingMemberIds = new Map();
let membershipWarning = '';

function plainErrorMessage(err) {
  return String(err.message || err).replace(/<[^>]+>/g, '');
}

// 상태 추적 키는 선택된 재생목록 id 기준 — 재생목록을 바꾸면 이전 재생목록에서의 결과와
// 자연히 구분된다.
function statusKey(videoId) {
  return `${targetPlaylistId}:${videoId}`;
}

function visibleVideos() {
  const phrase = els.phraseInput.value.trim();
  return uploads.filter((v) => !phrase || v.title.includes(phrase));
}

// 명시적으로 시도한 적 없어도, 재생목록 조회로 이미 들어있는 걸 알면 'skipped'로 쳐준다.
function effectiveState(video) {
  const explicit = statuses.get(statusKey(video.videoId))?.state;
  if (explicit) return explicit;
  return existingMemberIds.has(video.videoId) ? 'skipped' : null;
}

function isDone(video) {
  const state = effectiveState(video);
  return state === 'added' || state === 'skipped';
}

function setStatus(video, state, message = '') {
  statuses.set(statusKey(video.videoId), { state, message });
  render();
}

function renderSummary() {
  const visible = visibleVideos();
  const added = visible.filter((v) => effectiveState(v) === 'added').length;
  const failed = visible.filter((v) => effectiveState(v) === 'failed').length;
  const skipped = visible.filter((v) => effectiveState(v) === 'skipped').length;
  const hints = [`표시 ${visible.length}개`, `추가됨 ${added}`, `이미 있음 ${skipped}`, `실패 ${failed}`];
  if (skippedNoDate) hints.push(`날짜 없는 제목 ${skippedNoDate}개 제외`);
  if (targetPlaylistTitle) hints.push(`대상: ${targetPlaylistTitle}`);
  if (membershipWarning) hints.push(`⚠️ ${membershipWarning}`);
  if (batchHaltMessage) hints.push(`⛔ ${batchHaltMessage}`);
  els.summary.textContent = hints.join(' · ');
}

// 왼쪽 순서 번호(날짜순 정렬에서 몇 번째)와 재생목록 안 실제 순서가 같으면, 이미 올바른
// 자리에 들어가 있다는 뜻이라 초록으로 표시한다. index는 1부터 — "숨기기" 옵션으로 일부
// 항목을 안 보여줘도 이 번호는 전체 목록 기준 그대로 유지한다(숨긴 만큼 다시 당겨서
// 매기면 순서 일치 판정 자체가 틀어진다).
function isInOrder(video, index) {
  const position = existingMemberIds.get(video.videoId);
  return effectiveState(video) === 'skipped' && position === index;
}

function render() {
  const visible = visibleVideos();
  const hideInOrder = els.hideInOrderCheckbox.checked;
  const items = visible
    .map((video, i) => ({ video, index: i + 1 }))
    .filter(({ video, index }) => !hideInOrder || !isInOrder(video, index))
    .map(({ video, index }) => {
      const li = document.createElement('li');
      li.className = 'sorter-item';
      li.dataset.videoId = video.videoId;

      const indexEl = document.createElement('span');
      indexEl.textContent = `${index}.`;

      const title = document.createElement('a');
      title.className = 'sorter-title';
      title.href = `https://www.youtube.com/watch?v=${video.videoId}`;
      title.target = '_blank';
      title.rel = 'noopener';
      title.textContent = video.title;

      const state = effectiveState(video);
      const message = statuses.get(statusKey(video.videoId))?.message || '';
      const position = existingMemberIds.get(video.videoId);
      const inOrder = isInOrder(video, index);
      const statusEl = document.createElement('span');
      statusEl.className = `sorter-status ${state || ''}${inOrder ? ' in-order' : ''}`;
      statusEl.textContent = state === 'added' ? '추가됨'
        : state === 'skipped' ? (position ? `이미 있음 (${position}번째)` : '이미 있음')
        : state === 'failed' ? `실패: ${message}`
        : state === 'adding' ? '추가 중…'
        : '';

      const btn = document.createElement('button');
      btn.textContent = '추가';
      btn.className = 'btn-primary';
      btn.disabled = running || !targetPlaylistId || isDone(video) || state === 'adding';
      btn.addEventListener('click', () => addOne(video));

      li.append(indexEl, title, statusEl, btn);
      return li;
    });
  els.videoList.replaceChildren(...items);
  els.checkPlaylistBtn.disabled = !targetPlaylistId;
  els.autoBtn.disabled = !uploads.length || !targetPlaylistId;
  els.autoBtn.textContent = running ? '중지' : '자동 시작';
  renderSummary();

  // 자동 추가 중엔 지금 처리 중인 영상이 화면에 보이게 스크롤한다 — 중지 버튼은 고정 영역에
  // 있어서 이 스크롤과 무관하게 항상 누를 수 있다.
  if (autoScrollTargetId) {
    els.videoList.querySelector(`[data-video-id="${autoScrollTargetId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** 반환값: 성공 여부. 실패 시 호출한 쪽(runAuto)이 재시도 여부를 판단한다. */
async function addOne(video) {
  if (!targetPlaylistId) return false;
  setStatus(video, 'adding');
  try {
    // YouTube Data API(playlistItems.insert, 호출당 50쿼터) 대신 www.youtube.com 탭의 "저장"
    // 버튼을 직접 클릭하는 방식 — 쿼터를 전혀 안 쓴다. background.js + youtubePlaylistAdd.js 참고.
    // 이미 그 재생목록에 있으면 클릭 없이 alreadyExisted:true로 바로 성공 처리된다.
    const response = await chrome.runtime.sendMessage({
      action: 'ytAdd:add',
      videoId: video.videoId,
      playlistName: targetPlaylistTitle,
    });
    if (!response?.success) throw new Error(response?.error || '추가 실패 (응답 없음)');
    setStatus(video, response.alreadyExisted ? 'skipped' : 'added');
    // 재조회 없이는 몇 번째인지 모른다 — null로 "있는 건 아는데 순서는 모름" 상태로 남긴다.
    if (response.alreadyExisted && !existingMemberIds.has(video.videoId)) {
      existingMemberIds.set(video.videoId, null);
    }
    return true;
  } catch (err) {
    setStatus(video, 'failed', plainErrorMessage(err));
    return false;
  }
}

/** 제목 날짜 키(YYYYMMDD 숫자)를 ms epoch로. parseBroadcastStart가 없을 때의 대체 정렬용. */
function titleDateToMs(date) {
  const y = Math.floor(date / 10000);
  const mo = Math.floor(date / 100) % 100;
  const d = date % 100;
  return new Date(y, mo - 1, d).getTime();
}

/** 실패하면 재시도하고, 재시도를 다 써도 안 되면 다음 영상으로 넘어가지 않고 배치 전체를
 *  멈춘다 — 건너뛰고 계속하면 그 다음 영상들이 빈 자리를 메우며 순서가 밀려 꼬인다. */
async function runAuto() {
  if (running) {
    stopRequested = true;
    return;
  }
  running = true;
  stopRequested = false;
  batchHaltMessage = '';
  render();
  const targets = visibleVideos().filter((v) => !isDone(v));
  for (const video of targets) {
    if (stopRequested) break;
    autoScrollTargetId = video.videoId;
    render();

    let ok = false;
    for (let attempt = 1; attempt <= ADD_MAX_ATTEMPTS; attempt += 1) {
      if (stopRequested) break;
      ok = await addOne(video);
      if (ok || attempt === ADD_MAX_ATTEMPTS) break;
      const message = statuses.get(statusKey(video.videoId))?.message || '';
      setStatus(video, 'failed', `${message} (재시도 ${attempt}/${ADD_MAX_ATTEMPTS - 1} 대기 중…)`);
      await sleep(ADD_RETRY_DELAY_MS);
    }

    if (!ok && !stopRequested) {
      batchHaltMessage = `"${video.title}" 추가가 ${ADD_MAX_ATTEMPTS}번 다 실패해서 순서 보존을 위해 여기서 멈췄습니다 — 확인 후 다시 "자동 시작"을 눌러주세요.`;
      stopRequested = true;
      break;
    }
  }
  autoScrollTargetId = null;
  running = false;
  render();
}

/** 선택된 재생목록에 지금 들어있는 영상 id들을 Studio에서 긁어온다("재생목록 조회" 버튼
 *  핸들러). 탭은 background가 열고-조회하고-닫는 일회성이다(ytPlaylistVideos:fetchAll 핸들러
 *  참고). 제목은 드롭다운을 채울 때 이미 받아뒀으므로 여기서는 멤버십만 가져온다. */
async function refreshPlaylistInfo() {
  existingMemberIds = new Map();
  membershipWarning = '';
  if (!targetPlaylistId) {
    els.playlistLoadStatus.textContent = '재생목록을 먼저 선택하세요';
    return;
  }

  els.playlistLoadStatus.textContent = '탭을 열어 전체 영상 목록(Studio) 조회 중…';
  const response = await chrome.runtime.sendMessage({ action: 'ytPlaylistVideos:fetchAll', listId: targetPlaylistId });
  if (!response?.success) {
    console.warn('[PlaylistSorter] 재생목록 영상 목록(Studio) 조회 실패:', response?.error);
    els.playlistLoadStatus.textContent = `실패: ${plainErrorMessage(new Error(response?.error || '알 수 없는 오류'))}`;
    return;
  }
  // Studio가 전세계 차단 영상까지 포함해 완전하다 — 등장 순서가 재생목록 순서와 같으므로
  // 1부터 매겨서 "몇 번째인지" 표시에 쓴다.
  existingMemberIds = new Map(response.videoIds.map((id, i) => [id, i + 1]));
  if (response.complete === false) {
    membershipWarning = `재생목록을 끝까지 못 불러왔을 수 있음(지금까지 ${response.videoIds.length}개 확인) — "이미 있음" 표시가 일부 빠졌을 수 있음`;
    console.warn(`[PlaylistSorter] ${membershipWarning}`);
    els.playlistLoadStatus.textContent = `⚠️ 영상 ${response.videoIds.length}개만 확인(끝까지 못 불러옴)`;
  } else {
    els.playlistLoadStatus.textContent = `완료: 영상 ${response.videoIds.length}개 확인 (Studio, 차단 영상 포함)`;
  }
}

async function load() {
  els.loadBtn.disabled = true;
  els.videoLoadStatus.textContent = '탭을 열어 업로드 영상 목록 조회 중…';
  els.summary.textContent = '';
  try {
    // Data API가 아니라 vodList.js의 "유튜브 업로드 여부 확인"과 같은 경로(Studio 내부 API,
    // background.js의 fetchYoutubeVideos)로 가져온다 — 쿼터가 전혀 안 든다.
    // 재생목록 조회는 여기서 같이 하지 않는다 — 별도 "재생목록 조회" 버튼으로, 영상 목록이
    // 갖춰진 다음에 사용자가 원할 때만 그 탭을 연다.
    const videosResponse = await chrome.runtime.sendMessage({ action: 'youtubeVideos:fetchAll' });
    els.videoLoadStatus.textContent = videosResponse?.success
      ? `완료: 영상 ${videosResponse.videos.length}개 조회`
      : `실패: ${plainErrorMessage(new Error(videosResponse?.error || '알 수 없는 오류'))}`;
    if (!videosResponse?.success) throw new Error(videosResponse?.error || '영상 목록을 가져오지 못했습니다.');

    const parsed = [];
    const noDateTitles = [];
    skippedNoDate = 0;
    for (const video of videosResponse.videos) {
      const titleDate = parseTitleDate(video.title);
      if (!titleDate) {
        skippedNoDate += 1;
        noDateTitles.push({ title: video.title, url: `https://www.youtube.com/watch?v=${video.videoId}` });
        continue;
      }
      // 설명의 실제 방송 시작 시각이 있으면 그걸로 정렬하고, 없을 때만 제목 날짜(+n)로 대체한다.
      const broadcastStart = parseBroadcastStart(video.description);
      const sortTime = broadcastStart ?? titleDateToMs(titleDate.date) + titleDate.n;
      parsed.push({ videoId: video.videoId, title: video.title, sortTime });
    }
    if (noDateTitles.length) {
      console.log(`[PlaylistSorter] 날짜 없는 제목 ${noDateTitles.length}개`, noDateTitles);
    }
    parsed.sort((a, b) => a.sortTime - b.sortTime);
    uploads = parsed;
    render();
  } catch (err) {
    els.summary.textContent = `불러오기 실패: ${plainErrorMessage(err)}`;
  } finally {
    els.loadBtn.disabled = false;
  }
}

/** "내 재생목록 불러오기" — Studio의 재생목록 목록을 긁어와 드롭다운을 채운다
 *  (ytPlaylists:fetchAll → youtubePlaylistsList.js). 마지막으로 골랐던 id를 기억해뒀다가
 *  목록에 그대로 있으면 자동으로 다시 선택해준다. */
async function loadPlaylists() {
  els.loadPlaylistsBtn.disabled = true;
  els.playlistsLoadStatus.textContent = '탭을 열어 내 재생목록 조회 중…';
  try {
    const response = await chrome.runtime.sendMessage({ action: 'ytPlaylists:fetchAll' });
    if (!response?.success) throw new Error(response?.error || '재생목록을 가져오지 못했습니다.');

    const { playlistSorterLastPlaylistId } = await chrome.storage.local.get(['playlistSorterLastPlaylistId']);
    els.playlistSelect.replaceChildren(
      ...response.playlists.map((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title;
        return opt;
      })
    );
    els.playlistSelect.disabled = response.playlists.length === 0;
    if (playlistSorterLastPlaylistId && response.playlists.some((p) => p.id === playlistSorterLastPlaylistId)) {
      els.playlistSelect.value = playlistSorterLastPlaylistId;
    }
    handlePlaylistSelectChange();

    els.playlistsLoadStatus.textContent = response.complete === false
      ? `⚠️ 재생목록 ${response.playlists.length}개만 확인(끝까지 못 불러옴)`
      : `완료: 재생목록 ${response.playlists.length}개 조회`;
  } catch (err) {
    els.playlistsLoadStatus.textContent = `실패: ${plainErrorMessage(err)}`;
  } finally {
    els.loadPlaylistsBtn.disabled = false;
  }
}

function handlePlaylistSelectChange() {
  targetPlaylistId = els.playlistSelect.value || '';
  targetPlaylistTitle = els.playlistSelect.selectedOptions[0]?.textContent || '';
  existingMemberIds = new Map();
  membershipWarning = '';
  els.playlistLoadStatus.textContent = '';
  chrome.storage.local.set({ playlistSorterLastPlaylistId: targetPlaylistId });
  render();
}

async function handleCheckPlaylist() {
  els.checkPlaylistBtn.disabled = true;
  try {
    await refreshPlaylistInfo();
    render();
  } finally {
    els.checkPlaylistBtn.disabled = !targetPlaylistId ? true : false;
  }
}

els.loadBtn.addEventListener('click', load);
els.loadPlaylistsBtn.addEventListener('click', loadPlaylists);
els.playlistSelect.addEventListener('change', handlePlaylistSelectChange);
els.checkPlaylistBtn.addEventListener('click', handleCheckPlaylist);
els.autoBtn.addEventListener('click', runAuto);
els.phraseInput.addEventListener('input', render);
els.hideInOrderCheckbox.addEventListener('change', render);

// 고정된 상단 컨트롤 영역의 실제 높이를 CSS 변수로 반영해서, 내용이 길어져도(에러 메시지가
// 줄바꿈되는 등) 아래 목록이 그 밑에 깔리지 않게 한다.
const controlsBar = document.getElementById('controlsBar');
function syncControlsHeight() {
  document.documentElement.style.setProperty('--controls-height', `${controlsBar.offsetHeight + 16}px`);
}
new ResizeObserver(syncControlsHeight).observe(controlsBar);
syncControlsHeight();
