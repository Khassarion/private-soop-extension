/**
 * Content Script: VOD 파일별 상세 정보 패널
 * VOD 재생 페이지(vod.sooplive.com/player/{titleNo})에서 해당 VOD를 구성하는 파일별
 * 방송 당시 시작·종료 시각과 길이를 보여준다. 유튜브 업로드 시 설명란에 넣을 방송
 * 시간 메타데이터를 파일 단위로 빠르게 복사하기 위한 용도.
 */

(() => {
  const HOST_ID = 'private-extension-vod-file-info-host';
  const LOG_TAG = '[VodFileInfo]';
  // 지금 로드된 게 최신 버전인지 콘솔에서 바로 확인할 수 있도록 매번 찍는다.
  console.log(`${LOG_TAG} v${chrome.runtime.getManifest().version} 로드됨`);

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.vodFileInfo?.enabled === false) return;
    if (!getVideoIdFromLocation()) return; // VOD 재생 페이지가 아니면 아무것도 하지 않음
    initPanel();
  });

  function getVideoIdFromLocation() {
    const match = location.pathname.match(/\/player\/(\d+)/);
    return match ? match[1] : null;
  }

  function initPanel() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position: fixed; bottom: 20px; left: 20px; z-index: 2147483646;';
    document.documentElement.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { width: 340px; max-height: calc(100vh - 40px); overflow-y: auto; padding: 14px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.2); font: 13px/1.4 Arial, sans-serif; }
        .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; cursor: pointer; user-select: none; }
        h1 { margin: 0; font-size: 14px; color: #374151; white-space: nowrap; }
        .header-actions { display: flex; align-items: center; gap: 6px; }
        .icon-button { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: #f1f5f9; color: #475569; cursor: pointer; font-size: 13px; line-height: 1; }
        .icon-button:hover { background: #e2e8f0; }
        .panel.collapsed { width: auto; padding: 8px 10px; }
        .panel.collapsed .body { display: none; }
        .body { margin-top: 12px; }
        .vod-summary { font-size: 11px; color: #6b7280; margin-bottom: 10px; word-break: break-all; }
        .file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .file-item { padding: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
        .file-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
        .file-name { font-weight: 700; font-size: 12px; color: #333; }
        .file-duration { font-size: 11px; color: #6b7280; }
        .file-range { font-size: 12px; color: #333; margin-bottom: 4px; word-break: break-all; }
        .file-links { margin-bottom: 6px; }
        .file-link { font-size: 11px; color: #2563eb; text-decoration: none; }
        .file-link:hover { text-decoration: underline; }
        .file-actions { display: flex; gap: 6px; }
        .copy-button, .upload-button, .download-button { flex: 1; padding: 5px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; color: #2563eb; cursor: pointer; font-size: 11px; }
        .copy-button:hover, .upload-button:hover, .download-button:hover:not(:disabled) { background: #eff6ff; }
        .copy-button.copied { color: #16a34a; border-color: #86efac; }
        .download-button:disabled, .upload-button:disabled { opacity: .5; cursor: not-allowed; }
        .file-status { margin-top: 4px; font-size: 11px; color: #6b7280; }
        .file-status.error { color: #dc2626; }
        .copy-all-button { width: 100%; margin-bottom: 10px; padding: 7px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .copy-all-button:hover:not(:disabled) { background: #1d4ed8; }
        .copy-all-button:disabled { opacity: .6; cursor: not-allowed; }
        .run-all-button { background: #16a34a; }
        .run-all-button:hover:not(:disabled) { background: #15803d; }
        .stop-all-button { background: #dc2626; }
        .stop-all-button:hover:not(:disabled) { background: #b91c1c; }
        .stop-all-button[hidden] { display: none; }
        .storage-info { font-size: 11px; color: #6b7280; margin: -4px 0 10px; word-break: break-all; }
        .storage-info:empty { display: none; }
        .batch-status { margin: -4px 0 10px; font-size: 11px; color: #6b7280; }
        .batch-status:empty { display: none; }
        .batch-status.error { color: #dc2626; }
        .message { font-size: 12px; color: #6b7280; text-align: center; padding: 8px 0; }
        .message.error { color: #dc2626; }
      </style>
      <div class="panel collapsed">
        <div class="panel-header" id="header">
          <h1>🎬 VOD 파일별 정보</h1>
          <div class="header-actions">
            <button class="icon-button" id="refresh" title="새로고침">⟳</button>
          </div>
        </div>
        <div class="body">
          <div id="content"><p class="message">불러오는 중...</p></div>
        </div>
      </div>`;

    const panelElement = shadowRoot.querySelector('.panel');
    const header = shadowRoot.getElementById('header');
    const refreshButton = shadowRoot.getElementById('refresh');
    const contentEl = shadowRoot.getElementById('content');

    header.addEventListener('click', (event) => {
      if (event.target === refreshButton) return;
      const wasCollapsed = panelElement.classList.contains('collapsed');
      panelElement.classList.toggle('collapsed');
      if (wasCollapsed) loadVodFileInfo(contentEl);
    });

    refreshButton.addEventListener('click', (event) => {
      event.stopPropagation();
      loadVodFileInfo(contentEl);
    });

    currentPanelElement = panelElement;
    loadVodFileInfo(contentEl).then((renderResult) => {
      latestRenderResult = renderResult;
      tryStartAssignedBatch();
    });
  }

  // ---------------------------------------------------------------------------
  // 다시보기 배치: 목록 페이지(vodList.js)의 "모두 업로드"가 다시보기를 하나씩 순서대로
  // 맡긴다. background가 플레이어 탭을 이 다시보기로 연 뒤 vodBatch:begin을 보내주면,
  // 사용자 클릭 없이 "모두 다운로드&업로드"를 그대로 돌리고 끝나면(로컬 단계 — 다운로드 +
  // Studio 업로드 요청 제출 — 가 끝나는 즉시, Studio의 실제 전송 확인은 기다리지 않고)
  // vodBatch:complete로 결과를 돌려준다. vodBatch:begin이 패널 로딩보다 먼저 도착할 수
  // 있어(탭이 막 열린 직후), 패널이 준비될 때까지 payload를 들고 있다가 그때 시작한다.
  // ---------------------------------------------------------------------------
  let currentPanelElement = null;
  let latestRenderResult = null;
  let pendingBatchPayload = null;

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action === 'vodBatch:begin') {
      pendingBatchPayload = {
        videoId: String(request.videoId),
        skipFileOrders: Array.isArray(request.skipFileOrders) ? request.skipFileOrders.map(Number) : [],
      };
      tryStartAssignedBatch();
    }
    if (request?.action === 'vodBatch:cancelCurrent') {
      activeBatchCancelTrigger?.();
    }
  });

  function tryStartAssignedBatch() {
    if (!pendingBatchPayload || !latestRenderResult) return;
    const payload = pendingBatchPayload;
    pendingBatchPayload = null;
    if (payload.videoId !== getVideoIdFromLocation()) return; // 이 탭 몫이 아님(이론상 발생 안 함)
    runAssignedBatch(payload.skipFileOrders);
  }

  async function runAssignedBatch(skipFileOrders) {
    const videoId = getVideoIdFromLocation();
    console.log(`${LOG_TAG} 배치 시작 요청 받음: ${videoId}, 건너뛸 파일: [${skipFileOrders.join(', ')}]`);
    currentPanelElement.classList.remove('collapsed');
    // 무인 배치가 도는 동안은 영상이 재생될 이유가 없다(볼 사람이 없고 대역폭만 낭비함) —
    // 페이지가 로드되자마자(자동재생 포함) 곧바로 멈춰두고 배치가 끝나면 풀어준다.
    startBatchVideoPause();
    // skipFileOrders: 목록 페이지가 미리 판별해둔, 이 다시보기에서 유튜브에 이미 올라가
    // 있는 파일들 — 다시 다운로드/업로드하지 않고 건너뛴다.
    const { successOrders, failOrders, cancelled } = await latestRenderResult.runBatch(skipFileOrders);
    stopBatchVideoPause();

    try {
      // failOrders: [{fileOrder, reason}] — background가 각 실패를 로그/알림/저장소
      // 히스토리에 남길 수 있도록 이유까지 그대로 전달한다.
      await chrome.runtime.sendMessage({ action: 'vodBatch:complete', videoId, successOrders, failOrders, cancelled });
    } catch (error) {
      // 전달에 실패해도 vodList.js 쪽 안전망 타임아웃이 결국 이 다시보기를 실패로 치고 넘어간다.
    }
  }

  // 배치가 도는 동안 영상 재생을 막는다. 플레이어가 페이지 로드 뒤 늦게 <video>를 만들 수도
  // 있고, 자동재생이 붙을 수도 있어 liveMonitor.js와 같은 방식으로 MutationObserver로 계속
  // 지켜보다가 재생이 시작되면 즉시 다시 멈춘다.
  let batchVideoObserver = null;
  let batchWatchedVideo = null;

  function batchEnforcePause() {
    if (batchWatchedVideo && !batchWatchedVideo.paused) {
      batchWatchedVideo.pause();
    }
  }

  function batchTryAttachVideo() {
    const video = document.querySelector('video');
    if (!video || video === batchWatchedVideo) {
      batchEnforcePause();
      return;
    }
    if (batchWatchedVideo) batchWatchedVideo.removeEventListener('play', batchEnforcePause);
    batchWatchedVideo = video;
    video.addEventListener('play', batchEnforcePause);
    batchEnforcePause();
  }

  function startBatchVideoPause() {
    batchTryAttachVideo();
    batchVideoObserver = new MutationObserver(batchTryAttachVideo);
    batchVideoObserver.observe(document.documentElement, { childList: true, subtree: true });
    console.log(`${LOG_TAG} 배치 처리 중 영상 재생 정지 시작`);
  }

  function stopBatchVideoPause() {
    if (batchVideoObserver) {
      batchVideoObserver.disconnect();
      batchVideoObserver = null;
    }
    if (batchWatchedVideo) {
      batchWatchedVideo.removeEventListener('play', batchEnforcePause);
      batchWatchedVideo = null;
    }
  }

  async function loadVodFileInfo(contentEl) {
    const videoId = getVideoIdFromLocation();
    if (!videoId) {
      contentEl.innerHTML = '<p class="message error">VOD 재생 페이지가 아닙니다.</p>';
      return;
    }

    contentEl.innerHTML = '<p class="message">불러오는 중...</p>';

    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'vodFileInfo:fetch', videoId });
    } catch (error) {
      contentEl.innerHTML = '<p class="message error">확장 프로그램과 통신할 수 없습니다.</p>';
      return;
    }

    if (!response?.success) {
      contentEl.innerHTML = `<p class="message error">${escapeHtml(response?.error || 'VOD 정보를 가져오지 못했습니다.')}</p>`;
      return;
    }

    return renderFiles(contentEl, response.data, videoId);
  }

  function renderFiles(contentEl, data, videoId) {
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) {
      contentEl.innerHTML = '<p class="message">파일 정보가 없습니다.</p>';
      return;
    }

    const vodUrl = `https://vod.sooplive.com/player/${videoId}`;
    // 제목/라벨의 날짜는 파일별 시작 날짜가 아니라 이 다시보기 "첫 파일"의 시작 날짜로 통일한다.
    // 자정을 넘겨 이어진 방송은 뒤쪽 파일이 다음 날 새벽에 시작해서, 파일별 날짜를 쓰면
    // "14일 (1/3), 14일 (2/3), 15일 (3/3)"처럼 같은 방송이 다른 날짜로 올라가 헷갈린다.
    const firstFile = files.reduce((a, b) => (Number(b.file_order) < Number(a.file_order) ? b : a));
    const labelDate = new Date(firstFile.file_start);
    const metas = files.map((file, index) => buildFileMeta(file, index, vodUrl, files.length, labelDate));
    const getDownloadFileList = createDownloadFileListLoader(videoId);

    contentEl.innerHTML = '';

    const summary = document.createElement('div');
    summary.className = 'vod-summary';
    summary.textContent = `${data.bj_id ? `BJ: ${data.bj_id} · ` : ''}총 ${metas.length}개 파일`;
    contentEl.appendChild(summary);

    const storageInfo = document.createElement('div');
    storageInfo.className = 'storage-info';
    contentEl.appendChild(storageInfo);
    showStorageOverview(storageInfo);

    const copyAllButton = document.createElement('button');
    copyAllButton.className = 'copy-all-button';
    copyAllButton.textContent = '전체 복사';
    copyAllButton.addEventListener('click', () => {
      const text = metas.map((meta) => meta.text).join('\n\n');
      copyToClipboard(text, copyAllButton, '전체 복사');
    });
    contentEl.appendChild(copyAllButton);

    const runAllButton = document.createElement('button');
    runAllButton.className = 'copy-all-button run-all-button';
    runAllButton.textContent = '모두 다운로드&업로드';
    contentEl.appendChild(runAllButton);

    const stopButton = document.createElement('button');
    stopButton.className = 'copy-all-button stop-all-button';
    stopButton.textContent = '배치 중단';
    stopButton.hidden = true; // 배치가 도는 동안에만 보인다
    contentEl.appendChild(stopButton);

    const batchStatus = document.createElement('div');
    batchStatus.className = 'batch-status';
    contentEl.appendChild(batchStatus);

    const list = document.createElement('ul');
    list.className = 'file-list';
    const fileControls = [];

    metas.forEach((meta) => {
      const item = document.createElement('li');
      item.className = 'file-item';
      item.innerHTML = `
        <div class="file-top">
          <span class="file-name"></span>
          <span class="file-duration"></span>
        </div>
        <div class="file-range"></div>
        <div class="file-links"></div>
        <div class="file-actions">
          <button class="copy-button">정보 복사</button>
          <button class="download-button">다운로드</button>
          <button class="upload-button">유튜브에 업로드</button>
        </div>
        <div class="file-status"></div>
      `;
      item.querySelector('.file-name').textContent = meta.label;
      item.querySelector('.file-duration').textContent = meta.durationText;
      item.querySelector('.file-range').textContent = `${meta.startText} ~ ${meta.endText}`;

      const linksEl = item.querySelector('.file-links');
      if (meta.chatUrl) {
        const chatLink = document.createElement('a');
        chatLink.className = 'file-link';
        chatLink.href = meta.chatUrl;
        chatLink.target = '_blank';
        chatLink.rel = 'noopener noreferrer';
        chatLink.textContent = '채팅 로그 URL';
        linksEl.appendChild(chatLink);
      }

      const copyButton = item.querySelector('.copy-button');
      copyButton.addEventListener('click', () => copyToClipboard(meta.text, copyButton, '정보 복사'));

      setupUploadUI(item, meta, videoId, getDownloadFileList);
      setupDownloadUI(item, meta, videoId, getDownloadFileList);

      fileControls.push({
        downloadButton: item.querySelector('.download-button'),
        uploadButton: item.querySelector('.upload-button'),
        statusEl: item.querySelector('.file-status'),
      });

      list.appendChild(item);
    });

    contentEl.appendChild(list);

    runAllButton.addEventListener('click', () =>
      runDownloadUploadAll(metas, videoId, getDownloadFileList, fileControls, runAllButton, stopButton, batchStatus)
    );

    // 다시보기 파이프라인이 "모두 다운로드&업로드"를 버튼 클릭 없이 그대로 돌릴 수 있도록,
    // 실행 함수와 완료 판정에 쓸 fileOrder 목록을 돌려준다. alreadyUploadedFileOrders는
    // 파이프라인만 알고 있는(목록 페이지가 미리 판별해둔) 정보라 수동 클릭 쪽은 항상 빈
    // 배열로 호출해 기존 동작 그대로 둔다.
    return {
      fileOrders: metas.map((meta) => meta.fileOrder),
      runBatch: (alreadyUploadedFileOrders = []) =>
        runDownloadUploadAll(metas, videoId, getDownloadFileList, fileControls, runAllButton, stopButton, batchStatus, alreadyUploadedFileOrders),
    };
  }

  // 지금 돌고 있는 배치를 원격(vodList.js의 "중단" → background의 vodBatch:cancelCurrent)
  // 에서도 멈출 수 있도록, "배치 중단" 버튼과 같은 동작을 하는 함수를 실행 중인 동안만
  // 여기에 등록해둔다.
  let activeBatchCancelTrigger = null;

  /**
   * "모두 다운로드&업로드": 파일을 하나씩 순서대로 다운로드하고, 다운로드가 실제로 끝난 것을
   * 확인한 뒤에야 그 파일의 업로드(Studio 탭 열기/재사용)를 시작하고 바로 다음 파일 다운로드로
   * 넘어간다. 업로드 자체(Studio에서의 자동 입력·저장)가 끝나길 기다리지는 않는다 — 그건 별도
   * 탭에서 진행되며, 다음 파일을 내려받는 동안 백그라운드로 계속된다. 실패한 파일이 있어도
   * 배치 전체를 멈추지 않고 다음 파일로 넘어간다.
   * "배치 중단"을 누르면(또는 파이프라인이 원격으로 중단시키면) 진행 중이던 다운로드를
   * 취소하고 남은 파일은 처리하지 않는다. 이미 시작된 업로드(Studio 탭)는 되돌리지 않는다.
   * 다시보기 파이프라인이 "이 다시보기의 업로드 확인을 영원히 기다리지 않도록" 판단할 수
   * 있게, 로컬 단계(다운로드/업로드 시작)에서 끝내 실패했거나 처리하지 못한 파일의
   * fileOrder 목록을 successOrders/failOrders로 묶어 돌려준다.
   * alreadyUploadedFileOrders에 들어있는 fileOrder는 유튜브에 이미 올라가 있는 것으로
   * 확인된 파일이라, 다운로드도 업로드도 새로 시작하지 않고 곧바로 성공으로 처리한다
   * (수동 버튼 클릭 경로는 이 정보를 모르므로 항상 빈 배열로 호출돼 기존과 동일하다).
   */
  async function runDownloadUploadAll(
    metas,
    videoId,
    getDownloadFileList,
    fileControls,
    runAllButton,
    stopButton,
    batchStatus,
    alreadyUploadedFileOrders = []
  ) {
    let cancelled = false;
    const shouldCancel = () => cancelled;
    const cancelTrigger = () => {
      cancelled = true;
      stopButton.disabled = true;
      stopButton.textContent = '중단하는 중...';
    };
    stopButton.hidden = false;
    stopButton.disabled = false;
    stopButton.textContent = '배치 중단';
    stopButton.onclick = cancelTrigger;
    activeBatchCancelTrigger = cancelTrigger;

    const originalLabel = runAllButton.textContent;
    runAllButton.disabled = true;
    fileControls.forEach(({ downloadButton, uploadButton }) => {
      downloadButton.disabled = true;
      uploadButton.disabled = true;
    });
    batchStatus.textContent = '';
    batchStatus.classList.remove('error');

    const successOrders = [];
    // 실패한 fileOrder와 그 이유를 같이 들고 있는다 — 파이프라인이 "무엇이 왜 실패했는지"를
    // 로그/알림/저장소 히스토리에 그대로 남길 수 있어야 한다(사용자가 반드시 알아야 함).
    const failOrders = [];
    let processed = 0; // 중단 시 "처리하지 않은 파일" 개수 계산용
    // 실제로 다운로드가 진행되던 도중에 중단된 파일의 fileOrder — 일시정지 대기 중에 중단된
    // 경우(아무 파일도 실제로는 처리 중이 아니었음)와 구분하려고 실제 중단 지점에서 직접
    // 기록한다(processed > 0이라는 간접 추론은 일시정지-중 취소 시 틀릴 수 있어 쓰지 않는다).
    let cancelledMidFlightFileOrder = null;

    for (let i = 0; i < metas.length; i += 1) {
      if (cancelled) break;
      const meta = metas[i];
      const { statusEl } = fileControls[i];
      runAllButton.textContent = `${originalLabel} (${i + 1}/${metas.length} 진행 중)`;
      processed = i + 1;

      // 유튜브에 이미 올라가 있는 것으로 확인된 파일은 다운로드도 업로드도 새로 시작하지
      // 않는다 — 안 그러면 다시보기 일부만 올려둔 상태에서 배치를 다시 돌릴 때 이미 올라간
      // 파일까지 중복으로 재업로드하게 된다.
      if (alreadyUploadedFileOrders.includes(meta.fileOrder)) {
        setStatus(statusEl, '이미 유튜브에 업로드된 파일입니다 — 건너뜀', false);
        successOrders.push(meta.fileOrder);
        continue;
      }

      // 이미 다운로드해둔 파일이 디스크에 그대로 남아 있으면(기록만 믿지 않고 background가
      // chrome.downloads로 실제 존재를 재확인) 무조건 다시 받지 않고 바로 업로드로 넘어간다.
      const existing = await checkAlreadyDownloaded(videoId, meta.fileOrder);
      if (existing.exists) {
        setStatus(statusEl, `이미 다운로드된 파일을 그대로 사용합니다${existing.name ? ` (${existing.name})` : ''}`, false);
      } else {
        // 디스크 공간 부족/네트워크 오류는 downloadFileWithRetry 안에서 다음 파일로 넘기지
        // 않고 30분 뒤 같은 파일을 다시 시도한다(아래 함수 참고) — 그 외 실패만 여기로
        // 돌아온다.
        const downloadOutcome = await downloadFileWithRetry(meta, videoId, getDownloadFileList, statusEl, shouldCancel);
        if (downloadOutcome.cancelledMidFlight) {
          cancelledMidFlightFileOrder = meta.fileOrder;
          break;
        }
        if (!downloadOutcome.ok) {
          setStatus(statusEl, `다운로드 실패: ${downloadOutcome.error}`, true);
          failOrders.push({ fileOrder: meta.fileOrder, reason: downloadOutcome.error || '다운로드 실패' });
          continue;
        }
      }

      const uploadResult = await uploadFile(meta, videoId, getDownloadFileList, (text, isError) =>
        setStatus(statusEl, text, isError)
      );
      if (uploadResult.ok) successOrders.push(meta.fileOrder);
      else failOrders.push({ fileOrder: meta.fileOrder, reason: uploadResult.error || '업로드 시작 실패' });
    }

    // 중단됐다면, 아예 손 못 댄 나머지 파일들은 사람이 보는 요약에서 "처리하지 않음"으로
    // 표시한다(마침 다운로드 중이던 파일은 이미 자기 상태줄에 "중단됨"이 따로 떠서 여기
    // 숫자에는 포함하지 않는다 — 예전부터의 표시 방식 그대로). 다만 파이프라인에는 그 마침
    // 취소된 파일도 확인 신호가 절대 안 올 것이라고 알려야 하므로 반환값에는 따로 합친다.
    const untouchedOrders = metas.slice(processed).map((meta) => ({ fileOrder: meta.fileOrder, reason: '처리되지 않음(배치 중단)' }));
    const cancelledMidFlightOrder =
      cancelledMidFlightFileOrder != null ? { fileOrder: cancelledMidFlightFileOrder, reason: '다운로드 중 중단됨' } : null;
    const unconfirmableOrders =
      cancelledMidFlightOrder != null ? [...failOrders, cancelledMidFlightOrder, ...untouchedOrders] : [...failOrders, ...untouchedOrders];

    runAllButton.textContent = originalLabel;
    runAllButton.disabled = false;
    fileControls.forEach(({ downloadButton, uploadButton }) => {
      downloadButton.disabled = false;
      uploadButton.disabled = false;
    });

    stopButton.hidden = true;
    stopButton.onclick = null;
    activeBatchCancelTrigger = null;

    if (cancelled) {
      batchStatus.textContent =
        `중단됨: 업로드 시작 성공 ${successOrders.length}개, 실패 ${failOrders.length}개` +
        (untouchedOrders.length > 0 ? `, 처리하지 않은 파일 ${untouchedOrders.length}개` : '');
      batchStatus.classList.add('error');
    } else {
      batchStatus.textContent = `완료: 업로드 시작 성공 ${successOrders.length}개, 실패 ${failOrders.length}개`;
      batchStatus.classList.toggle('error', failOrders.length > 0);
    }
    console.log(
      `[VodFileInfo] 모두 다운로드&업로드 ${cancelled ? '중단' : '완료'}: 성공 ${successOrders.length} / 실패 ${failOrders.length}`
    );

    return { successOrders, failOrders: unconfirmableOrders, cancelled };
  }

  function setStatus(statusEl, text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  /** 디스크별 전체 용량과 확장이 받은 파일의 합계를 보여준다(남은 용량은 Chrome이 제공하지 않음). */
  async function showStorageOverview(el) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'storage:overview' });
      if (!response?.success) return;
      const { disks, files } = response.data;
      const diskText = disks.length > 0 ? disks.map((d) => formatBytes(d.capacity)).join(' / ') : '확인 불가';
      el.textContent =
        `디스크 전체 용량: ${diskText} (남은 용량은 Chrome이 제공하지 않음) · ` +
        `받은 파일 ${files.count}개, ${formatBytes(files.bytes)}`;
    } catch (_error) {
      // 표시 전용이라 실패해도 무시
    }
  }

  function formatBytes(bytes) {
    const gb = bytes / 1024 ** 3;
    if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)}GB`;
    return `${Math.round(bytes / 1024 ** 2)}MB`;
  }

  function buildFileMeta(file, index, vodUrl, totalCount, labelDate) {
    const start = new Date(file.file_start);
    const durationMs = Number(file.duration) || 0;
    const end = new Date(start.getTime() + durationMs);

    const startText = formatDateTime(start);
    const endText = formatDateTime(end);
    const durationText = formatDuration(durationMs);
    const chatUrl = file.chat || null;

    const dateLabel = formatKoreanDate(labelDate || start); // 방송 시간 텍스트는 파일별 실제 시각 그대로
    const label = totalCount > 1
      ? `${dateLabel} (${index + 1}/${totalCount})`
      : dateLabel;

    const descriptionLines = [
      `VOD: ${vodUrl}`,
      `방송 시간: ${startText} ~ ${endText} (${durationText})`,
    ];
    if (chatUrl) descriptionLines.push(`채팅 로그: ${chatUrl}`);
    const descriptionText = descriptionLines.join('\n');

    return {
      index,
      fileOrder: Number(file.file_order),
      label,
      startText,
      endText,
      durationText,
      vodUrl,
      chatUrl,
      descriptionText,
      text: `[${label}]\n${descriptionText}`,
    };
  }

  function formatKoreanDate(date) {
    if (Number.isNaN(date.getTime())) return '알 수 없는 날짜';
    return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
  }

  function formatDateTime(date) {
    if (Number.isNaN(date.getTime())) return '알 수 없음';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  async function copyToClipboard(text, button, defaultLabel) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '복사됨!';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = defaultLabel;
        button.classList.remove('copied');
      }, 1500);
    } catch (error) {
      button.textContent = '복사 실패';
      setTimeout(() => {
        button.textContent = defaultLabel;
      }, 1500);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** "유튜브에 업로드" 버튼: 실제 동작은 uploadFile()이 하고, 여기서는 버튼만 연결한다. */
  function setupUploadUI(item, meta, videoId, getDownloadFileList) {
    const uploadButton = item.querySelector('.upload-button');
    const statusEl = item.querySelector('.file-status');

    uploadButton.addEventListener('click', async () => {
      uploadButton.disabled = true;
      await uploadFile(meta, videoId, getDownloadFileList, (text, isError) => setStatus(statusEl, text, isError));
      uploadButton.disabled = false;
    });
  }

  /**
   * "유튜브에 업로드" 버튼(및 "모두 다운로드&업로드" 배치)이 공유하는 실제 로직: YouTube
   * Studio 업로드 창을 새 탭으로 열거나 idle한 기존 탭을 재사용하면서, 이 파일의 제목/설명을
   * background에 맡겨둔다. Studio 탭에 붙는 youtubeStudio.js가 업로드 창에서 파일이
   * 첨부되면 그 값을 제목/설명 칸에 자동으로 채워준다. 이 함수는 업로드 창을 "여는 것"까지만
   * 책임지며, Studio 안에서의 자동 입력·저장이 끝나는 것을 기다리지 않는다.
   */
  async function uploadFile(meta, videoId, getDownloadFileList, onStatus) {
    onStatus('업로드 창을 여는 중...', false);

    try {
      // 다운로드용 파일 목록에서 원본 방송 제목을 얻을 수 있으면 뒤에 붙이고,
      // 못 얻으면(로그인 문제 등) 대괄호 부분만으로 진행한다.
      let title = `[${meta.label}]`;
      // Studio 업로드 창에 자동 첨부할 파일의 후보 이름: 우리 다운로드 버튼으로 받았을 때
      // 기록해둔 실제 저장 이름(브라우저가 바꿨을 수 있음) + Soop이 알려준 원래 파일명.
      const fileNames = [];
      try {
        const fileList = await getDownloadFileList();
        const entry = fileList.find((f) => Number(f.file_order) === meta.fileOrder);
        const contentTitle = entry ? deriveContentTitle(entry.file_name) : '';
        if (contentTitle) title = `${title} ${contentTitle}`;

        if (entry) {
          const { downloadedFiles } = await chrome.storage.local.get(['downloadedFiles']);
          const savedName = downloadedFiles?.[downloadRecordKey(videoId, entry.file_order)]?.name;
          if (savedName) fileNames.push(savedName);
          if (entry.file_name && !fileNames.includes(entry.file_name)) fileNames.push(entry.file_name);
        }
      } catch (_error) {
        // 대괄호만 있는 제목 유지, 파일 자동 첨부는 건너뛴다(직접 선택)
      }

      const response = await chrome.runtime.sendMessage({
        action: 'studio:upload',
        title,
        description: meta.descriptionText,
        fileNames,
        // "업로드 확인 후 자동 삭제"가 정확히 어느 로컬 파일을 지칭하는지 알 수 있도록 전달한다.
        // 실제로 그 파일이 자동 첨부됐을 때만(youtubeStudio.js 쪽에서) 삭제를 시도하게 된다.
        videoId,
        fileOrder: meta.fileOrder,
      });
      if (!response?.success) {
        throw new Error(response?.error || '업로드 요청을 보내지 못했습니다.');
      }
      // Studio 탭은 하나만 두고 재사용한다. 순서 관리는 그 탭의 content script가 자체
      // 큐로 하므로, 여기서는 "요청을 전달했다"까지만 확인할 수 있다.
      onStatus(
        'Studio 탭에 업로드를 요청했습니다. 탭이 준비되는 대로 자동으로 시작됩니다. 다운로드 폴더를 연결해두면 파일도 자동으로 첨부됩니다.',
        false
      );
      return { ok: true };
    } catch (error) {
      onStatus(`업로드 창 열기 실패: ${error.message}`, true);
      return { ok: false, error: error.message };
    }
  }

  /**
   * "6일차) 노래뱅인데 고음하는 방법을 깨먹었다_1.mp4" 같은 다운로드 파일명에서
   * 확장자와 파일 순번 접미사(_1, _2 ...)를 제거해 원본 방송 제목만 남긴다.
   */
  function deriveContentTitle(fileName) {
    if (!fileName) return '';
    return fileName.replace(/\.[^./]+$/, '').replace(/_\d+$/, '');
  }

  /**
   * VOD 파일 다운로드. chk_download_auth.php는 vod.sooplive.com "자기 자신"에 대한
   * same-origin 요청이라 (background를 거칠 필요 없는) content script fetch로 충분하다.
   * 실제 파일 바이트를 내려받는 동작만 chrome.downloads API(extension 전용)가 필요해
   * background에 위임한다.
   */
  const DOWNLOAD_AUTH_ENDPOINT = 'https://vod.sooplive.com/api/chk_download_auth.php';

  /**
   * 같은 VOD의 파일 목록(FILE_LIST) 조회를 파일 항목마다 반복하지 않도록 캐시하는
   * 로더를 만든다. 실패하면 다음 호출 때 재시도할 수 있도록 캐시를 비운다.
   */
  function createDownloadFileListLoader(videoId) {
    let promise = null;
    return () => {
      if (!promise) {
        promise = fetchDownloadFileList(videoId).catch((error) => {
          promise = null;
          throw error;
        });
      }
      return promise;
    };
  }

  async function fetchDownloadFileList(videoId) {
    const res = await fetch(DOWNLOAD_AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `szWork=LIST&nTitleNo=${encodeURIComponent(videoId)}&nSkipAdult=0`,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`파일 목록 조회 실패 (${res.status})`);

    const data = await res.json();
    if (data.RESULT !== 1 || !Array.isArray(data.FILE_LIST)) {
      throw new Error('다운로드 가능한 파일이 없습니다. 로그인 상태를 확인해주세요.');
    }
    return data.FILE_LIST;
  }

  async function requestDownloadUrl(videoId, fileOrder, fileLevel, fileName) {
    const body = new URLSearchParams({
      szWork: 'DOWN_URL',
      nTitleNo: String(videoId),
      nFileOrder: String(fileOrder),
      szFileLevel: fileLevel,
      szFileName: fileName,
      clipFrom: '',
      clipTo: '',
    });

    const res = await fetch(DOWNLOAD_AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`다운로드 주소 요청 실패 (${res.status})`);

    const data = await res.json();
    if (data.RESULT !== 1 || !data.DOWN_URL) {
      throw new Error('다운로드 주소를 받지 못했습니다.');
    }
    return data.DOWN_URL;
  }

  // 다운로드한 파일의 실제 저장 이름을 기록해두는 키 (background가 완료 시 기록, 업로드 시 읽음)
  function downloadRecordKey(videoId, fileOrder) {
    return `${videoId}:${Number(fileOrder)}`;
  }

  /** 다운로드를 시작하고 chrome.downloads의 downloadId를 돌려준다(완료 확인에 쓰인다). */
  async function startBrowserDownload(url, filename, record) {
    const response = await chrome.runtime.sendMessage({
      action: 'download:start',
      url,
      filename,
      videoId: record.videoId,
      fileOrder: record.fileOrder,
    });
    if (!response?.success) {
      throw new Error(response?.error || '다운로드를 시작하지 못했습니다.');
    }
    return response.downloadId;
  }

  // 배치가 한 파일의 다운로드가 끝나길 기다리는 방식: background가 완료/중단 시 기록하는
  // downloadOutcomes[downloadId]를 폴링한다. 서비스 워커가 다운로드 도중 죽어도 storage는
  // 남아 있으므로 메시지 채널을 오래 열어두는 방식보다 안정적이다. 대용량 VOD와 느린 회선을
  // 고려해 넉넉하게 기다린다.
  const DOWNLOAD_OUTCOME_POLL_MS = 1000;
  const DOWNLOAD_WAIT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
  // 디스크 공간 부족이나 네트워크 오류는 시간이 지나면 저절로 풀릴 수 있는 일시적인 문제라,
  // 다음 파일로 넘어가지 않고 이 시간만큼 기다린 뒤 같은 파일을 처음부터(다운로드 주소
  // 재요청부터) 다시 시도한다. 성공하거나 배치가 중단될 때까지 횟수 제한 없이 반복한다.
  const DOWNLOAD_RETRY_WAIT_MS = 30 * 60 * 1000;
  const DOWNLOAD_RETRY_WAIT_POLL_MS = 2000; // 대기 중에도 "배치 중단"이 바로 먹히도록 자주 확인

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 진행 중인 다운로드를 취소한다(background가 chrome.downloads.cancel 호출). 실패해도 무시. */
  async function cancelDownload(downloadId) {
    try {
      await chrome.runtime.sendMessage({ action: 'download:cancel', downloadId });
    } catch (_error) {
      // 이미 끝났거나 확장 컨텍스트 문제 — 중단 자체는 계속 진행한다
    }
  }

  /**
   * shouldCancel()이 true가 되면 기다림을 멈추고 { cancelled: true }를 돌려준다(배치 중단용).
   * 시간 초과면 null.
   */
  async function waitForDownloadOutcome(downloadId, timeoutMs, shouldCancel = () => false) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (shouldCancel()) return { ok: false, cancelled: true };
      const { downloadOutcomes = {} } = await chrome.storage.local.get(['downloadOutcomes']);
      const outcome = downloadOutcomes[downloadId];
      if (outcome) {
        delete downloadOutcomes[downloadId];
        await chrome.storage.local.set({ downloadOutcomes });
        return outcome;
      }
      await sleep(DOWNLOAD_OUTCOME_POLL_MS);
    }
    return null; // 시간 초과
  }

  /**
   * 디스크 공간 부족이나 네트워크 오류로 보이는 실패인지 판단한다. chrome.downloads가
   * 중단시키면 delta.error.current로 `FILE_NO_SPACE`/`NETWORK_*` 같은 정해진 상수 문자열이
   * 오므로(waitForDownloadOutcome의 outcome.error) 그건 정확히 매칭하고, 다운로드 시작
   * 전 단계(주소 요청 등)의 실패는 브라우저/네트워크 계층의 일반 오류 메시지라 형식이
   * 정해져 있지 않아 "network"/"fetch"/디스크 공간 관련 키워드로 짐작한다(완벽하지 않음).
   */
  function isRetryableDownloadError(reason) {
    const text = String(reason || '');
    if (/^(NETWORK_|FILE_NO_SPACE)/.test(text)) return true;
    return /network|fetch|no.?space|disk/i.test(text);
  }

  /** 재시도까지 남은 시간을 상태줄에 보여주며 기다린다. shouldCancel()이 true가 되면 즉시 빠져나온다. */
  async function waitBeforeDownloadRetry(statusEl, reason, shouldCancel) {
    console.warn(`${LOG_TAG} 다운로드 오류(${reason}) — ${DOWNLOAD_RETRY_WAIT_MS / 60000}분 뒤 같은 파일을 다시 시도합니다.`);
    const resumeAt = Date.now() + DOWNLOAD_RETRY_WAIT_MS;
    while (Date.now() < resumeAt && !shouldCancel()) {
      const remainingMin = Math.ceil((resumeAt - Date.now()) / 60000);
      setStatus(statusEl, `다운로드 오류(${reason}) — ${remainingMin}분 뒤 같은 파일을 다시 시도합니다.`, true);
      await sleep(Math.min(DOWNLOAD_RETRY_WAIT_POLL_MS, Math.max(resumeAt - Date.now(), 0)));
    }
  }

  /**
   * downloadFile() + waitForDownloadOutcome()을 감싸서, 디스크 공간 부족/네트워크 오류로
   * 보이는 실패는 다음 파일로 넘기지 않고 DOWNLOAD_RETRY_WAIT_MS 뒤 같은 파일을 처음부터
   * (다운로드 주소 재요청부터) 다시 시도한다 — 횟수 제한 없이, 성공하거나 배치가 중단될
   * 때까지. 그 외의 실패(파일 정보 없음, 화질 정보 없음 등 영구적인 문제)는 기존처럼 바로
   * 실패로 돌려준다. 반환값: { ok } | { ok:false, error } | { ok:false, cancelledMidFlight }.
   */
  async function downloadFileWithRetry(meta, videoId, getDownloadFileList, statusEl, shouldCancel) {
    for (;;) {
      const downloadResult = await downloadFile(meta, videoId, getDownloadFileList, (text, isError) =>
        setStatus(statusEl, text, isError)
      );
      if (!downloadResult.ok) {
        if (!shouldCancel() && isRetryableDownloadError(downloadResult.error)) {
          await waitBeforeDownloadRetry(statusEl, downloadResult.error, shouldCancel);
          if (!shouldCancel()) continue;
        }
        return { ok: false, error: downloadResult.error || '다운로드 실패' };
      }

      if (shouldCancel()) {
        await cancelDownload(downloadResult.downloadId);
        setStatus(statusEl, '중단됨: 다운로드를 취소했습니다.', true);
        return { ok: false, cancelledMidFlight: true };
      }

      setStatus(statusEl, '다운로드 완료 확인 중...', false);
      const outcome = await waitForDownloadOutcome(downloadResult.downloadId, DOWNLOAD_WAIT_TIMEOUT_MS, shouldCancel);
      if (outcome?.cancelled) {
        await cancelDownload(downloadResult.downloadId);
        setStatus(statusEl, '중단됨: 다운로드를 취소했습니다.', true);
        return { ok: false, cancelledMidFlight: true };
      }
      if (outcome?.ok) return { ok: true };

      const reason = outcome?.error || '다운로드 완료 확인 시간 초과';
      if (!shouldCancel() && isRetryableDownloadError(reason)) {
        await waitBeforeDownloadRetry(statusEl, reason, shouldCancel);
        if (!shouldCancel()) continue;
      }
      return { ok: false, error: reason };
    }
  }

  function setupDownloadUI(item, meta, videoId, getDownloadFileList) {
    const downloadButton = item.querySelector('.download-button');
    const statusEl = item.querySelector('.file-status');

    downloadButton.addEventListener('click', async () => {
      downloadButton.disabled = true;
      await downloadFile(meta, videoId, getDownloadFileList, (text, isError) => setStatus(statusEl, text, isError));
      downloadButton.disabled = false;
    });
  }

  /**
   * "모두 다운로드&업로드" 배치가 이 파일을 다시 받을 필요가 있는지 background에 물어본다.
   * background가 downloadedFiles 기록뿐 아니라 chrome.downloads로 실제 디스크 존재까지
   * 재확인하므로, 사용자가 파일을 직접 지운 경우는 그냥 false로 돌아와 정상적으로 다시 받는다.
   */
  async function checkAlreadyDownloaded(videoId, fileOrder) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'download:findExisting', videoId, fileOrder });
      return response?.exists ? { exists: true, name: response.name } : { exists: false };
    } catch (error) {
      return { exists: false };
    }
  }

  /**
   * "다운로드" 버튼(및 "모두 다운로드&업로드" 배치)이 공유하는 실제 로직. 다운로드를 "시작"하는
   * 것까지만 책임지고, 완료를 기다리려면 성공 시 돌려주는 downloadId로 waitForDownloadOutcome을
   * 쓴다.
   */
  async function downloadFile(meta, videoId, getDownloadFileList, onStatus) {
    onStatus('다운로드 정보 조회 중...', false);

    try {
      const fileList = await getDownloadFileList();
      const entry = fileList.find((f) => Number(f.file_order) === meta.fileOrder);
      if (!entry) throw new Error('다운로드 가능한 파일 정보를 찾을 수 없습니다.');

      const quality = entry.file_low?.[0];
      if (!quality) throw new Error('다운로드 화질 정보를 찾을 수 없습니다.');

      onStatus('다운로드 주소 요청 중...', false);
      const downUrl = await requestDownloadUrl(videoId, entry.file_order, quality.name, entry.file_name);

      onStatus('다운로드 시작...', false);
      const downloadId = await startBrowserDownload(downUrl, entry.file_name, {
        videoId,
        fileOrder: Number(entry.file_order),
      });
      onStatus('다운로드가 시작되었습니다 (브라우저 다운로드 목록 확인).', false);
      return { ok: true, downloadId, entry };
    } catch (error) {
      onStatus(`다운로드 실패: ${error.message}`, true);
      return { ok: false, error: error.message };
    }
  }
})();
