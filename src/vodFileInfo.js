/**
 * Content Script: VOD 파일별 상세 정보 패널
 * VOD 재생 페이지(vod.sooplive.com/player/{titleNo})에서 해당 VOD를 구성하는 파일별
 * 방송 당시 시작·종료 시각과 길이를 보여준다. 유튜브 업로드 시 설명란에 넣을 방송
 * 시간 메타데이터를 파일 단위로 빠르게 복사하기 위한 용도.
 */

(() => {
  const HOST_ID = 'private-extension-vod-file-info-host';

  // 유튜브 업로드는 이 탭(content script)이 파일을 청크로 잘라 background에 계속
  // 보내줘야 끝까지 진행된다 — 탭을 닫으면 업로드가 중간에 그냥 멈추고 재생목록에도
  // 추가되지 않는다. 진행 중에 실수로 탭을 닫지 않도록 경고창을 띄운다.
  let activeYoutubeUploadCount = 0;
  window.addEventListener('beforeunload', (event) => {
    if (activeYoutubeUploadCount <= 0) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // 계정의 재생목록 목록은 패널이 열려있는 동안 한 번만 조회해서 모든 업로드 폼이 공유한다.
  let youtubePlaylistsPromise = null;
  function getYoutubePlaylists() {
    if (!youtubePlaylistsPromise) {
      youtubePlaylistsPromise = fetchYoutubePlaylists().catch((error) => {
        youtubePlaylistsPromise = null;
        throw error;
      });
    }
    return youtubePlaylistsPromise;
  }

  async function fetchYoutubePlaylists() {
    const response = await chrome.runtime.sendMessage({ action: 'youtubePlaylists:fetch' });
    if (!response?.success) {
      throw new Error(response?.error || '재생목록을 불러오지 못했습니다.');
    }
    return response.playlists;
  }

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
        .copy-button, .upload-toggle-button, .download-button { flex: 1; padding: 5px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; color: #2563eb; cursor: pointer; font-size: 11px; }
        .copy-button:hover, .upload-toggle-button:hover, .download-button:hover:not(:disabled) { background: #eff6ff; }
        .copy-button.copied { color: #16a34a; border-color: #86efac; }
        .download-button:disabled { opacity: .5; cursor: not-allowed; }
        .download-status { margin-top: 4px; font-size: 11px; color: #6b7280; }
        .download-status.error { color: #dc2626; }
        .copy-all-button { width: 100%; margin-bottom: 10px; padding: 7px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .copy-all-button:hover { background: #1d4ed8; }
        .upload-form { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #cbd5e1; display: flex; flex-direction: column; gap: 6px; }
        .upload-field { display: flex; flex-direction: column; gap: 2px; }
        .upload-field label { font-size: 10px; color: #6b7280; }
        .upload-field input[type="text"], .upload-field textarea, .upload-field select {
          font: inherit; font-size: 11px; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 4px; width: 100%; resize: vertical;
        }
        .upload-start-button { padding: 6px; border: 0; border-radius: 5px; background: #16a34a; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
        .upload-start-button:hover:not(:disabled) { background: #15803d; }
        .upload-start-button:disabled { opacity: .5; cursor: not-allowed; }
        .upload-progress { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; display: none; }
        .upload-progress-fill { height: 100%; width: 0%; background: #16a34a; transition: width .2s; }
        .upload-status { font-size: 11px; color: #6b7280; }
        .upload-status.error { color: #dc2626; }
        .upload-status a { color: #2563eb; }
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

    loadVodFileInfo(contentEl);
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

    renderFiles(contentEl, response.data, videoId);
  }

  function renderFiles(contentEl, data, videoId) {
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) {
      contentEl.innerHTML = '<p class="message">파일 정보가 없습니다.</p>';
      return;
    }

    const vodUrl = `https://vod.sooplive.com/player/${videoId}`;
    const metas = files.map((file, index) => buildFileMeta(file, index, vodUrl, files.length));
    const getDownloadFileList = createDownloadFileListLoader(videoId);

    contentEl.innerHTML = '';

    const summary = document.createElement('div');
    summary.className = 'vod-summary';
    summary.textContent = `${data.bj_id ? `BJ: ${data.bj_id} · ` : ''}총 ${metas.length}개 파일`;
    contentEl.appendChild(summary);

    const copyAllButton = document.createElement('button');
    copyAllButton.className = 'copy-all-button';
    copyAllButton.textContent = '전체 복사';
    copyAllButton.addEventListener('click', () => {
      const text = metas.map((meta) => meta.text).join('\n\n');
      copyToClipboard(text, copyAllButton, '전체 복사');
    });
    contentEl.appendChild(copyAllButton);

    const list = document.createElement('ul');
    list.className = 'file-list';

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
          <button class="upload-toggle-button">유튜브에 업로드</button>
        </div>
        <div class="download-status"></div>
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

      setupUploadUI(item, meta, getDownloadFileList);
      setupDownloadUI(item, meta, videoId, getDownloadFileList);

      list.appendChild(item);
    });

    contentEl.appendChild(list);
  }

  function buildFileMeta(file, index, vodUrl, totalCount) {
    const start = new Date(file.file_start);
    const durationMs = Number(file.duration) || 0;
    const end = new Date(start.getTime() + durationMs);

    const startText = formatDateTime(start);
    const endText = formatDateTime(end);
    const durationText = formatDuration(durationMs);
    const chatUrl = file.chat || null;

    const dateLabel = formatKoreanDate(start);
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

  /**
   * 파일 항목에 "업로드" 토글 버튼과 인라인 업로드 폼을 붙인다.
   * 실제 유튜브 업로드 네트워크 요청은 background(포트 'youtubeUpload')가 수행한다.
   * (content script의 fetch/XHR은 host_permissions가 있어도 페이지 출처 기준 CORS
   * 제약을 받아 googleapis.com 업로드에 그대로 쓸 수 없다 — extension 컨텍스트만 예외.)
   */
  function setupUploadUI(item, meta, getDownloadFileList) {
    const toggleButton = item.querySelector('.upload-toggle-button');
    let form = null;

    toggleButton.addEventListener('click', () => {
      if (!form) {
        form = buildUploadForm(meta, getDownloadFileList);
        item.appendChild(form);
      }
      form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    });
  }

  /**
   * "6일차) 노래뱅인데 고음하는 방법을 깨먹었다_1.mp4" 같은 다운로드 파일명에서
   * 확장자와 파일 순번 접미사(_1, _2 ...)를 제거해 원본 방송 제목만 남긴다.
   */
  function deriveContentTitle(fileName) {
    if (!fileName) return '';
    return fileName.replace(/\.[^./]+$/, '').replace(/_\d+$/, '');
  }

  function buildUploadForm(meta, getDownloadFileList) {
    const form = document.createElement('div');
    form.className = 'upload-form';
    form.style.display = 'none';
    form.innerHTML = `
      <div class="upload-field">
        <label>제목</label>
        <input type="text" class="upload-title">
      </div>
      <div class="upload-field">
        <label>설명</label>
        <textarea class="upload-description" rows="3"></textarea>
      </div>
      <div class="upload-field">
        <label>공개 범위</label>
        <select class="upload-privacy">
          <option value="private">비공개</option>
          <option value="unlisted">미등록(링크 공유)</option>
          <option value="public">공개</option>
        </select>
      </div>
      <div class="upload-field">
        <label>재생목록 (선택)</label>
        <select class="upload-playlist">
          <option value="">불러오는 중...</option>
        </select>
      </div>
      <div class="upload-field">
        <label>동영상 파일</label>
        <input type="file" class="upload-file-input" accept="video/*">
      </div>
      <div class="upload-progress"><div class="upload-progress-fill"></div></div>
      <div class="upload-status"></div>
      <button class="upload-start-button" disabled>업로드 시작</button>
    `;

    const titleInput = form.querySelector('.upload-title');
    const descriptionTextarea = form.querySelector('.upload-description');
    const privacySelect = form.querySelector('.upload-privacy');
    const playlistInput = form.querySelector('.upload-playlist');
    const fileInput = form.querySelector('.upload-file-input');
    const progressEl = form.querySelector('.upload-progress');
    const progressFill = form.querySelector('.upload-progress-fill');
    const statusEl = form.querySelector('.upload-status');
    const startButton = form.querySelector('.upload-start-button');

    titleInput.value = `[${meta.label}]`;
    descriptionTextarea.value = meta.descriptionText;

    getDownloadFileList()
      .then((fileList) => {
        const entry = fileList.find((f) => Number(f.file_order) === meta.index + 1);
        const contentTitle = entry ? deriveContentTitle(entry.file_name) : '';
        if (contentTitle) titleInput.value = `[${meta.label}] ${contentTitle}`;
      })
      .catch(() => {
        // 다운로드 목록을 못 가져와도 대괄호만 있는 제목으로 업로드는 계속 진행 가능
      });

    getYoutubePlaylists()
      .then((playlists) => {
        playlistInput.innerHTML = '<option value="">추가 안 함</option>';
        for (const playlist of playlists) {
          const option = document.createElement('option');
          option.value = playlist.id;
          option.textContent = playlist.title;
          playlistInput.appendChild(option);
        }
        chrome.storage.local.get(['lastYoutubePlaylistId']).then(({ lastYoutubePlaylistId }) => {
          if (lastYoutubePlaylistId && playlists.some((p) => p.id === lastYoutubePlaylistId)) {
            playlistInput.value = lastYoutubePlaylistId;
          }
        });
      })
      .catch((error) => {
        playlistInput.innerHTML = `<option value="">추가 안 함 (목록 조회 실패: ${escapeHtml(error.message)})</option>`;
      });

    let selectedFile = null;

    fileInput.addEventListener('change', () => {
      selectedFile = fileInput.files[0] || null;
      startButton.disabled = !selectedFile;
      statusEl.textContent = '';
      statusEl.classList.remove('error');
    });

    startButton.addEventListener('click', () => {
      if (!selectedFile) return;

      const playlistId = playlistInput.value || null;
      chrome.storage.local.set({ lastYoutubePlaylistId: playlistId || '' });

      startButton.disabled = true;
      fileInput.disabled = true;
      titleInput.disabled = true;
      descriptionTextarea.disabled = true;
      privacySelect.disabled = true;
      playlistInput.disabled = true;
      progressEl.style.display = 'block';
      progressFill.style.width = '0%';
      statusEl.classList.remove('error');
      statusEl.textContent = '업로드 준비 중...';

      activeYoutubeUploadCount += 1;

      startYoutubeUpload({
        file: selectedFile,
        title: titleInput.value.trim() || `[${meta.label}]`,
        description: descriptionTextarea.value,
        privacy: privacySelect.value,
        playlistId,
        onProgress: (ratio) => {
          progressFill.style.width = `${Math.round(ratio * 100)}%`;
          statusEl.textContent = `업로드 중... ${Math.round(ratio * 100)}%`;
        },
        onStatus: (text) => {
          statusEl.textContent = text;
        },
        onDone: (video, playlistError) => {
          activeYoutubeUploadCount = Math.max(0, activeYoutubeUploadCount - 1);
          progressFill.style.width = '100%';
          const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
          let html = `업로드 완료: <a href="${videoUrl}" target="_blank" rel="noopener noreferrer">${videoUrl}</a>`;
          if (playlistId) {
            html += playlistError
              ? `<br>재생목록 추가 실패: ${escapeHtml(playlistError)}`
              : '<br>재생목록에 추가되었습니다.';
          }
          statusEl.innerHTML = html;
          if (playlistError) statusEl.classList.add('error');
          startButton.textContent = '업로드 완료';
        },
        onError: (message) => {
          activeYoutubeUploadCount = Math.max(0, activeYoutubeUploadCount - 1);
          statusEl.textContent = `업로드 실패: ${message}`;
          statusEl.classList.add('error');
          startButton.textContent = '재시도';
          startButton.disabled = false;
          fileInput.disabled = false;
          titleInput.disabled = false;
          descriptionTextarea.disabled = false;
          privacySelect.disabled = false;
          playlistInput.disabled = false;
        },
      });
    });

    return form;
  }

  // Google 리줌 업로드는 청크 크기가 256KiB의 배수여야 한다(마지막 청크 제외). 4MiB.
  const YOUTUBE_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

  /**
   * ArrayBuffer를 base64 문자열로 변환한다.
   * chrome.runtime 메시징은 JSON 직렬화만 지원해 ArrayBuffer/Uint8Array를 그대로
   * 보내면 빈 객체({})로 도착한다(실제로 겪은 문제 - 몇 바이트짜리 body만 전송됨).
   * 문자열로 바꿔 보내는 게 JSON으로도 안전하게 전달되는 유일한 방법이다.
   */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000; // String.fromCharCode 호출 인자 개수 제한 회피
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  /**
   * background의 'youtubeUpload' 포트로 파일을 청크(base64 문자열) 단위로 전달해
   * 업로드를 진행시킨다. 실제 googleapis.com 요청(토큰 발급 포함)은 background에서
   * 수행한다. File/Blob이나 ArrayBuffer를 그대로 넘기지 않는다 — chrome.runtime
   * 메시징은 JSON 직렬화만 지원해서 바이너리 데이터가 유실된다(실제로 겪은 문제).
   */
  function startYoutubeUpload({ file, title, description, privacy, playlistId, onProgress, onStatus, onDone, onError }) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'youtubeUpload' });
    } catch (error) {
      onError('확장 프로그램과 연결할 수 없습니다.');
      return;
    }

    let offset = 0;

    const sendNextChunk = async () => {
      const end = Math.min(offset + YOUTUBE_UPLOAD_CHUNK_SIZE, file.size);
      const isLast = end >= file.size;
      let data;
      try {
        const buffer = await file.slice(offset, end).arrayBuffer();
        data = arrayBufferToBase64(buffer);
      } catch (error) {
        onError('파일을 읽는 중 오류가 발생했습니다.');
        port.disconnect();
        return;
      }
      port.postMessage({ type: 'chunk', data, start: offset, end, isLast });
      offset = end;
    };

    port.onMessage.addListener((message) => {
      if (message?.type === 'ready') {
        sendNextChunk();
      } else if (message?.type === 'chunkAck') {
        sendNextChunk();
      } else if (message?.type === 'progress') {
        onProgress(message.ratio);
      } else if (message?.type === 'status') {
        onStatus(message.message);
      } else if (message?.type === 'done') {
        onDone(message.video, message.playlistError);
        port.disconnect();
      } else if (message?.type === 'error') {
        onError(message.message);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        onError(chrome.runtime.lastError.message || '업로드 연결이 끊어졌습니다.');
      }
    });

    port.postMessage({
      type: 'start',
      title,
      description,
      privacy,
      playlistId,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    });
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

  async function startBrowserDownload(url, filename) {
    const response = await chrome.runtime.sendMessage({ action: 'download:start', url, filename });
    if (!response?.success) {
      throw new Error(response?.error || '다운로드를 시작하지 못했습니다.');
    }
  }

  function setupDownloadUI(item, meta, videoId, getDownloadFileList) {
    const downloadButton = item.querySelector('.download-button');
    const statusEl = item.querySelector('.download-status');

    downloadButton.addEventListener('click', async () => {
      downloadButton.disabled = true;
      statusEl.classList.remove('error');
      statusEl.textContent = '다운로드 정보 조회 중...';

      try {
        const fileList = await getDownloadFileList();
        const entry = fileList.find((f) => Number(f.file_order) === meta.index + 1);
        if (!entry) throw new Error('다운로드 가능한 파일 정보를 찾을 수 없습니다.');

        const quality = entry.file_low?.[0];
        if (!quality) throw new Error('다운로드 화질 정보를 찾을 수 없습니다.');

        statusEl.textContent = '다운로드 주소 요청 중...';
        const downUrl = await requestDownloadUrl(videoId, entry.file_order, quality.name, entry.file_name);

        statusEl.textContent = '다운로드 시작...';
        await startBrowserDownload(downUrl, entry.file_name);
        statusEl.textContent = '다운로드가 시작되었습니다 (브라우저 다운로드 목록 확인).';
      } catch (error) {
        statusEl.textContent = `다운로드 실패: ${error.message}`;
        statusEl.classList.add('error');
      } finally {
        downloadButton.disabled = false;
      }
    });
  }
})();
