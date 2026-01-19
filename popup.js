/**
 * Popup UI 로직
 */

let songSearch = null;
let taskRunner = null;
let soopHandler = null;
let currentSongInfo = null;

// DOM 요소
const songQueryInput = document.getElementById('songQuery');
const searchBtn = document.getElementById('searchBtn');
const apiKeyInput = document.getElementById('apiKey');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const songResult = document.getElementById('songResult');
const songTitle = document.getElementById('songTitle');
const songChannel = document.getElementById('songChannel');
const songDuration = document.getElementById('songDuration');
const songThumbnail = document.getElementById('songThumbnail');
const taskDescription = document.getElementById('taskDescription');
const startTaskBtn = document.getElementById('startTaskBtn');
const taskStatus = document.getElementById('taskStatus');
const progressFill = document.getElementById('progressFill');
const elapsedTime = document.getElementById('elapsedTime');
const remainingTime = document.getElementById('remainingTime');
const stopTaskBtn = document.getElementById('stopTaskBtn');
const message = document.getElementById('message');

// Soop DOM 요소
const soopStatusText = document.getElementById('soopStatusText');
const checkSoopBtn = document.getElementById('checkSoopBtn');
const getSoopInfoBtn = document.getElementById('getSoopInfoBtn');
const soopInfo = document.getElementById('soopInfo');
const soopInfoText = document.getElementById('soopInfoText');

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  // 저장된 API 키 불러오기
  const savedApiKey = await loadApiKey();
  if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
    songSearch = new SongSearch(savedApiKey);
  } else {
    showMessage('YouTube API Key를 입력해주세요. (선택사항이지만 권장)', 'info');
  }

  taskRunner = new TaskRunner();
  soopHandler = new SoopHandler();
  
  setupEventListeners();
  setupTaskRunnerCallbacks();
  
  // Soop 페이지 확인
  await checkSoopPage();
});

// 이벤트 리스너 설정
function setupEventListeners() {
  // 검색 버튼
  searchBtn.addEventListener('click', handleSearch);
  songQueryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  });

  // API 키 저장
  saveApiKeyBtn.addEventListener('click', handleSaveApiKey);

  // 작업 시작
  startTaskBtn.addEventListener('click', handleStartTask);

  // 작업 중지
  stopTaskBtn.addEventListener('click', handleStopTask);

  // Soop 버튼
  checkSoopBtn.addEventListener('click', handleCheckSoop);
  getSoopInfoBtn.addEventListener('click', handleGetSoopInfo);
}

// TaskRunner 콜백 설정
function setupTaskRunnerCallbacks() {
  taskRunner.on('onStart', (data) => {
    taskStatus.style.display = 'block';
    startTaskBtn.disabled = true;
    showMessage('작업이 시작되었습니다!', 'success');
  });

  taskRunner.on('onTick', (data) => {
    updateProgress(data);
  });

  taskRunner.on('onComplete', (data) => {
    showMessage(`작업이 완료되었습니다! (${formatTime(data.elapsed)} 실행)`, 'success');
    resetTaskUI();
  });

  taskRunner.on('onStop', (data) => {
    showMessage(`작업이 중지되었습니다. (${formatTime(data.elapsed)} 실행)`, 'info');
    resetTaskUI();
  });
}

// 노래 검색 처리
async function handleSearch() {
  const query = songQueryInput.value.trim();
  
  if (!query) {
    showMessage('검색어를 입력해주세요.', 'error');
    return;
  }

  // API 키가 없으면 기본 검색 시도 (제한적)
  if (!songSearch) {
    showMessage('YouTube API Key가 필요합니다. API Key를 입력해주세요.', 'error');
    return;
  }

  try {
    searchBtn.disabled = true;
    searchBtn.textContent = '검색 중...';
    showMessage('검색 중...', 'info');

    const songInfo = await songSearch.searchSong(query);
    currentSongInfo = songInfo;

    // 결과 표시
    songTitle.textContent = songInfo.title;
    songChannel.textContent = songInfo.channelTitle;
    songDuration.textContent = `길이: ${songSearch.formatDuration(songInfo.durationInSeconds)}`;
    songThumbnail.src = songInfo.thumbnail;
    songResult.style.display = 'block';

    startTaskBtn.disabled = false;
    showMessage('노래를 찾았습니다!', 'success');
  } catch (error) {
    showMessage(`검색 실패: ${error.message}`, 'error');
    songResult.style.display = 'none';
    startTaskBtn.disabled = true;
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '검색';
  }
}

// API 키 저장
async function handleSaveApiKey() {
  const apiKey = apiKeyInput.value.trim();
  
  if (!apiKey) {
    showMessage('API Key를 입력해주세요.', 'error');
    return;
  }

  try {
    await chrome.storage.local.set({ youtubeApiKey: apiKey });
    songSearch = new SongSearch(apiKey);
    showMessage('API Key가 저장되었습니다.', 'success');
  } catch (error) {
    showMessage(`저장 실패: ${error.message}`, 'error');
  }
}

// 작업 시작
async function handleStartTask() {
  if (!currentSongInfo) {
    showMessage('먼저 노래를 검색해주세요.', 'error');
    return;
  }

  if (taskRunner.isRunning) {
    showMessage('이미 작업이 실행 중입니다.', 'error');
    return;
  }

  const duration = currentSongInfo.durationInSeconds;
  const taskDesc = taskDescription.value.trim();

  // 여기에 실제 작업 함수를 추가할 수 있습니다
  const taskFunction = async () => {
    console.log('작업 시작:', taskDesc || '기본 작업');
    // 실제 작업 로직을 여기에 구현
    // 예: 탭 새로고침, 특정 웹사이트 방문, 알림 표시 등
  };

  await taskRunner.start(duration, taskFunction);
}

// 작업 중지
function handleStopTask() {
  if (taskRunner.isRunning) {
    taskRunner.stop(false);
  }
}

// 진행 상황 업데이트
function updateProgress(data) {
  progressFill.style.width = `${data.progress}%`;
  elapsedTime.textContent = formatTime(data.elapsed);
  remainingTime.textContent = formatTime(data.remaining);
}

// 작업 UI 리셋
function resetTaskUI() {
  taskStatus.style.display = 'none';
  startTaskBtn.disabled = false;
  progressFill.style.width = '0%';
  elapsedTime.textContent = '0:00';
  remainingTime.textContent = '0:00';
}

// 시간 포맷팅
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// 메시지 표시
function showMessage(text, type = 'info') {
  message.textContent = text;
  message.className = `message ${type}`;
  message.style.display = 'block';

  setTimeout(() => {
    message.style.display = 'none';
  }, 5000);
}

// API 키 불러오기
async function loadApiKey() {
  try {
    const result = await chrome.storage.local.get(['youtubeApiKey']);
    return result.youtubeApiKey || null;
  } catch (error) {
    // 에러 발생 시 null 반환 (조용히 처리)
    return null;
  }
}

// Soop 페이지 확인
async function checkSoopPage() {
  try {
    const isSoop = await soopHandler.isSoopTab();
    if (isSoop) {
      soopStatusText.textContent = '✅ Soop 페이지가 활성화되어 있습니다.';
      soopStatusText.style.color = '#4CAF50';
      getSoopInfoBtn.disabled = false;
    } else {
      soopStatusText.textContent = '❌ 현재 Soop 페이지가 아닙니다.';
      soopStatusText.style.color = '#f44336';
      getSoopInfoBtn.disabled = true;
    }
  } catch (error) {
    soopStatusText.textContent = `오류: ${error.message}`;
    soopStatusText.style.color = '#f44336';
    getSoopInfoBtn.disabled = true;
  }
}

// Soop 페이지 확인 버튼 핸들러
async function handleCheckSoop() {
  checkSoopBtn.disabled = true;
  checkSoopBtn.textContent = '확인 중...';
  await checkSoopPage();
  checkSoopBtn.disabled = false;
  checkSoopBtn.textContent = 'Soop 페이지 확인';
}

// Soop 정보 가져오기 버튼 핸들러
async function handleGetSoopInfo() {
  try {
    getSoopInfoBtn.disabled = true;
    getSoopInfoBtn.textContent = '가져오는 중...';
    showMessage('Soop 정보를 가져오는 중...', 'info');

    const info = await soopHandler.getSoopInfo();
    
    // 정보 표시
    soopInfoText.textContent = JSON.stringify(info, null, 2);
    soopInfo.style.display = 'block';
    
    showMessage('Soop 정보를 가져왔습니다!', 'success');
  } catch (error) {
    showMessage(`Soop 정보 가져오기 실패: ${error.message}`, 'error');
    soopInfo.style.display = 'none';
  } finally {
    getSoopInfoBtn.disabled = false;
    getSoopInfoBtn.textContent = '정보 가져오기';
  }
}
