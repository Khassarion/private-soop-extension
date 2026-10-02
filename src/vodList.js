/**
 * Content Script: 방송국 다시보기 목록 페이지(www.sooplive.com/station/{bjId}/vod...)에서
 * 각 다시보기가 유튜브에 올라갔는지 판별해 보여준다. 판별 근거는 내 채널의 실제 업로드 영상:
 * 설명의 Soop 다시보기 링크로 어느 다시보기인지, 제목의 "[날짜 (n/max)]"로 몇 번째 파일인지 맞춘다
 * (매칭 규칙은 youtubeMatch.js). 파일이 하나라도 안 올라갔으면 그 다시보기는 미업로드로 본다.
 *
 * "모두 업로드" 버튼은 위 판별로 추린 미업로드 다시보기들을 이 페이지 자신이 큐로 들고
 * 하나씩 순서대로 처리한다: background에 vodBatch:start를 보내면 플레이어 탭을 그
 * 다시보기로 열어주고, 그 페이지(vodFileInfo.js)가 "모두 다운로드&업로드"를 스스로 돌린
 * 뒤 로컬 단계(다운로드 + Studio 업로드 요청 제출)가 끝나는 즉시 vodBatch:complete를
 * 돌려준다 — Studio(youtubeStudio.js)의 실제 업로드 전송 확인은 기다리지 않는다.
 */

(() => {
  const LOG_TAG = '[VodList]';
  const HOST_ID = 'private-extension-vod-list-host';
  // 지금 로드된 게 최신 버전인지 콘솔에서 바로 확인할 수 있도록 매번 찍는다.
  console.log(`${LOG_TAG} v${chrome.runtime.getManifest().version} 로드됨`);

  if (!/^\/station\/[^/]+\/vod(\/|$)/.test(location.pathname)) return;

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.vodFileInfo?.enabled === false) return;
    mountButton();
  });

  /** 현재 DOM에 렌더된 다시보기 링크(…/player/{id})에서 중복 없이 아이디를 순서대로 모은다. */
  function collectVideoIds() {
    const ids = [];
    for (const a of document.querySelectorAll('a[href*="/player/"]')) {
      const m = a.href.match(/\/player\/(\d+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  }

  // ---------------------------------------------------------------------------
  // 배치 큐: 이 페이지(vodList.js) 자신이 "처리할 다시보기 목록"을 들고 순서대로 하나씩
  // background에 vodBatch:start를 보낸다. background는 플레이어 탭을 열어 넘겨줄 뿐,
  // 큐/진행 상태는 전부 여기(탭의 메모리)에 있다 — 그래서 이 탭이 새로고침되면 진행 중이던
  // 배치는 복원하지 않고 그냥 끊긴다(단순함 우선, 플레이어 탭 쪽도 동일한 정책).
  // vodFileInfo.js가 로컬 단계(다운로드 + Studio 업로드 요청 제출)를 끝내는 즉시
  // vodBatch:complete를 보내오며, Studio의 실제 전송 확인은 기다리지 않는다. 응답 자체가
  // 유실될 경우를 대비해 다시보기 하나당 안전망 타임아웃을 건다.
  // ---------------------------------------------------------------------------
  const VOD_BATCH_TIMEOUT_MS = 12 * 60 * 60 * 1000;
  let batchQueue = [];
  let batchDone = [];
  let batchFailed = [];
  let batchCurrentVideoId = null;
  let batchTimeoutTimer = null;
  let outEl = null;
  let stopButtonEl = null;
  let pipelineButtonEl = null;

  function renderBatchState() {
    const lines = [
      batchCurrentVideoId ? `진행 중: ${batchCurrentVideoId}` : batchQueue.length > 0 ? '다음 다시보기 준비 중...' : '',
      `남은 다시보기: ${batchQueue.length}개`,
      `완료: ${batchDone.length}개 · 실패: ${batchFailed.length}개`,
      batchFailed.length > 0 ? `[실패 목록]\n${batchFailed.map((f) => `${f.videoId} (${f.reason})`).join('\n')}` : '',
    ].filter(Boolean);
    outEl.textContent = lines.join('\n');
  }

  /** 지금 처리 중인 게 없으면 큐에서 다음 다시보기를 꺼내 시작한다. 큐가 비었으면 종료 처리. */
  async function advanceBatchQueue() {
    if (batchCurrentVideoId != null) return;
    if (batchQueue.length === 0) {
      stopButtonEl.hidden = true;
      pipelineButtonEl.disabled = false;
      renderBatchState();
      console.log(`${LOG_TAG} 배치 종료 — 완료 ${batchDone.length}개, 실패 ${batchFailed.length}개`);
      return;
    }

    const next = batchQueue.shift();
    batchCurrentVideoId = next.videoId;
    renderBatchState();

    const res = await chrome.runtime
      .sendMessage({ action: 'vodBatch:start', videoId: next.videoId, skipFileOrders: next.skipFileOrders })
      .catch(() => null);
    if (!res?.success) {
      batchFailed.push({ videoId: next.videoId, reason: '배치 시작 요청 실패' });
      batchCurrentVideoId = null;
      advanceBatchQueue();
      return;
    }

    clearTimeout(batchTimeoutTimer);
    batchTimeoutTimer = setTimeout(() => {
      console.warn(`${LOG_TAG} ${next.videoId} 완료 응답 시간 초과 — 실패로 치고 다음으로 진행`);
      batchFailed.push({ videoId: next.videoId, reason: '시간 초과' });
      batchCurrentVideoId = null;
      advanceBatchQueue();
    }, VOD_BATCH_TIMEOUT_MS);
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action !== 'vodBatch:complete') return;
    if (request.videoId !== batchCurrentVideoId) return; // 이미 시간 초과 등으로 처리된 옛 응답
    clearTimeout(batchTimeoutTimer);
    batchCurrentVideoId = null;
    const failOrders = Array.isArray(request.failOrders) ? request.failOrders : [];
    if (request.cancelled) {
      batchFailed.push({ videoId: request.videoId, reason: '중단됨' });
    } else if (failOrders.length > 0) {
      batchFailed.push({ videoId: request.videoId, reason: `${failOrders.length}개 파일 실패` });
    } else {
      batchDone.push(request.videoId);
    }
    renderBatchState();
    advanceBatchQueue();
  });

  function mountButton() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .row{display:flex;gap:6px;justify-content:flex-end}
        button{padding:8px 12px;border:0;border-radius:6px;background:#3b5bdb;color:#fff;cursor:pointer}
        button:disabled{opacity:.6;cursor:default}
        #pipeline-btn{background:#16a34a}
        #stop-btn{background:#dc2626}
        #stop-btn[hidden]{display:none}
        pre{margin:6px 0 0;max-width:420px;max-height:320px;overflow:auto;padding:8px;background:#fff;
            color:#222;border:1px solid #ccc;border-radius:6px;white-space:pre-wrap;user-select:text}
      </style>
      <div class="row">
        <button id="check-btn">유튜브 업로드 여부 확인</button>
        <button id="pipeline-btn">모두 업로드</button>
        <button id="stop-btn" hidden>중단</button>
      </div>
      <pre hidden></pre>`;
    const checkButton = shadow.getElementById('check-btn');
    const pipelineButton = shadow.getElementById('pipeline-btn');
    const stopButton = shadow.getElementById('stop-btn');
    const out = shadow.querySelector('pre');
    outEl = out;
    stopButtonEl = stopButton;
    pipelineButtonEl = pipelineButton;

    checkButton.addEventListener('click', async () => {
      checkButton.disabled = true;
      out.hidden = false;
      out.textContent = '유튜브 영상 목록을 가져오는 중... (Studio 탭을 잠깐 열 수 있습니다)';
      try {
        const { pending, uploaded, all, youtubeVideoCount } = await checkMatch();
        out.textContent = formatCheckResult(pending, uploaded, all, youtubeVideoCount);
      } catch (error) {
        out.textContent = `실패: ${error.message}`;
      } finally {
        checkButton.disabled = false;
      }
    });

    pipelineButton.addEventListener('click', async () => {
      pipelineButton.disabled = true;
      out.hidden = false;
      out.textContent = '유튜브 업로드 여부를 먼저 확인하는 중...';
      try {
        const { pending } = await checkMatch();
        if (pending.length === 0) {
          out.textContent = '이 페이지의 다시보기가 모두 이미 업로드돼 있습니다.';
          pipelineButton.disabled = false;
          return;
        }
        // checkMatch()가 이미 파일 단위로 유튜브 업로드 여부를 판별해뒀다(vod.files[].uploaded,
        // fileOrder 포함) — 다시보기 전체가 미완료(pending)라도 그중 일부 파일은 이미 올라가
        // 있을 수 있으므로, 배치가 그 파일까지 다시 올리지 않도록 다시보기별로 넘겨준다.
        batchQueue = pending.map((vod) => ({
          videoId: vod.videoId,
          skipFileOrders: (vod.files || []).filter((f) => f.uploaded).map((f) => f.fileOrder),
        }));
        batchDone = [];
        batchFailed = [];
        console.log(`${LOG_TAG} 배치 시작: ${batchQueue.length}개`, batchQueue.map((v) => v.videoId));
        stopButton.hidden = false;
        stopButton.disabled = false;
        stopButton.textContent = '중단';
        advanceBatchQueue();
      } catch (error) {
        out.textContent = `실패: ${error.message}`;
        pipelineButton.disabled = false;
      }
    });

    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true;
      stopButton.textContent = '중단하는 중...';
      batchQueue = []; // 아직 시작하지 않은 나머지 다시보기는 더 이상 진행하지 않는다
      await chrome.runtime.sendMessage({ action: 'vodBatch:cancel' }).catch(() => {});
    });

    document.body.appendChild(host);
  }

  function formatVod(vod) {
    if (vod.error) return `${vod.videoId}  (${vod.error})`;
    const head = `${vod.videoId}  ${vod.complete ? '업로드 완료' : '미업로드/일부 미업로드'}`;
    const files = vod.files.map((f) => {
      const label = `  (${f.n}/${vod.fileCount})`;
      if (!f.uploaded) return `${label} ✗ 미업로드`;
      const notes = [f.privacy, f.duplicates ? `중복 ${f.duplicates}개` : '', f.maxMismatch ? '제목의 max 불일치' : '']
        .filter(Boolean)
        .join(', ');
      return `${label} ✓ ${f.youtubeUrl}${notes ? ` [${notes}]` : ''}`;
    });
    return [head, ...files].join('\n');
  }

  function formatCheckResult(pending, uploaded, all, youtubeVideoCount) {
    return [
      `유튜브 영상 ${youtubeVideoCount}개 조회 · 다시보기 ${all.length}개 중 미업로드 ${pending.length}개`,
      '',
      '[미업로드 아이디]',
      pending.map((v) => v.videoId).join('\n') || '(없음)',
      '',
      '[상세]',
      ...all.map(formatVod),
    ].join('\n');
  }

  /** 이 페이지의 다시보기들을 유튜브 업로드 영상과 대조해 미업로드/완료를 가른다. */
  async function checkMatch() {
    const videoIds = collectVideoIds();
    if (videoIds.length === 0) throw new Error('이 페이지에서 다시보기 링크를 찾지 못했습니다.');

    const res = await chrome.runtime.sendMessage({ action: 'vodUpload:match', videoIds });
    if (!res?.success) throw new Error(res?.error || '판별 실패');

    const pending = res.vods.filter((v) => !v.error && !v.complete);
    const uploaded = res.vods.filter((v) => !v.error && v.complete);
    console.log(`${LOG_TAG} 미업로드 ${pending.length} / 업로드 완료 ${uploaded.length} / 전체 ${videoIds.length}`, {
      pendingIds: pending.map((v) => v.videoId),
      vods: res.vods,
    });
    // 업로드 자동화가 붙을 지점(다시보기 파이프라인 외의 다른 자동화가 필요해지면 여기서 이어받는다)
    window.dispatchEvent(new CustomEvent('private-extension:vod-match', { detail: { pending, uploaded, all: res.vods } }));

    return { pending, uploaded, all: res.vods, youtubeVideoCount: res.youtubeVideoCount };
  }
})();
