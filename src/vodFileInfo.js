/**
 * Content Script: VOD 파일별 상세 정보 패널
 * VOD 재생 페이지(vod.sooplive.com/player/{titleNo})에서 해당 VOD를 구성하는 파일별
 * 방송 당시 시작·종료 시각과 길이를 보여준다. 유튜브 업로드 시 설명란에 넣을 방송
 * 시간 메타데이터를 파일 단위로 빠르게 복사하기 위한 용도.
 */

(() => {
  const HOST_ID = 'private-extension-vod-file-info-host';

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
        .copy-all-button:hover { background: #1d4ed8; }
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
   * "유튜브에 업로드" 버튼: YouTube Studio 업로드 창을 새 탭으로 열면서, 이 파일의
   * 제목/설명을 background에 맡겨둔다. Studio 탭에 붙는 youtubeStudio.js가 업로드 창에서
   * 사용자가 mp4를 고르면 그 값을 제목/설명 칸에 자동으로 채워준다.
   * (파일 자체는 브라우저가 로컬 경로 접근을 막고 확장 메시징으로 큰 바이너리를 옮길 수도
   * 없어서, Studio의 "파일 선택"에서 사용자가 직접 고르는 단계가 남는다.)
   */
  function setupUploadUI(item, meta, getDownloadFileList) {
    const uploadButton = item.querySelector('.upload-button');
    const statusEl = item.querySelector('.file-status');

    uploadButton.addEventListener('click', async () => {
      uploadButton.disabled = true;
      statusEl.classList.remove('error');
      statusEl.textContent = '업로드 창을 여는 중...';

      try {
        // 다운로드용 파일 목록에서 원본 방송 제목을 얻을 수 있으면 뒤에 붙이고,
        // 못 얻으면(로그인 문제 등) 대괄호 부분만으로 진행한다.
        let title = `[${meta.label}]`;
        try {
          const fileList = await getDownloadFileList();
          const entry = fileList.find((f) => Number(f.file_order) === meta.index + 1);
          const contentTitle = entry ? deriveContentTitle(entry.file_name) : '';
          if (contentTitle) title = `${title} ${contentTitle}`;
        } catch (_error) {
          // 대괄호만 있는 제목 유지
        }

        const response = await chrome.runtime.sendMessage({
          action: 'youtubeStudio:open',
          title,
          description: meta.descriptionText,
        });
        if (!response?.success) {
          throw new Error(response?.error || '업로드 창을 열지 못했습니다.');
        }
        statusEl.textContent = 'Studio 업로드 창을 열었습니다. mp4를 선택하면 제목/설명이 자동으로 입력됩니다.';
      } catch (error) {
        statusEl.textContent = `업로드 창 열기 실패: ${error.message}`;
        statusEl.classList.add('error');
      } finally {
        uploadButton.disabled = false;
      }
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
    const statusEl = item.querySelector('.file-status');

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
