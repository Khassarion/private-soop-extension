/**
 * Content Script: 방송국 다시보기 목록 페이지(www.sooplive.com/station/{bjId}/vod...)에서
 * 각 다시보기가 유튜브에 올라갔는지 판별해 보여준다. 판별 근거는 내 채널의 실제 업로드 영상:
 * 설명의 Soop 다시보기 링크로 어느 다시보기인지, 제목의 "[날짜 (n/max)]"로 몇 번째 파일인지 맞춘다
 * (매칭 규칙은 youtubeMatch.js). 파일이 하나라도 안 올라갔으면 그 다시보기는 미업로드로 본다.
 *
 * "모두 업로드" 버튼은 위 판별로 추린 미업로드 다시보기들을 background의 다시보기 파이프라인에
 * 넘긴다. 파이프라인은 다시보기 플레이어 탭 하나를 재사용해 순서대로 열며, 각 플레이어 페이지
 * (vodFileInfo.js)가 스스로 "모두 다운로드&업로드"를 돌리고, Studio 탭(youtubeStudio.js)이 각
 * 파일의 업로드 확인 신호를 보내면 그걸로 완료를 판단해 다음 다시보기로 넘어간다.
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
        #pause-btn{background:#d97706}
        #pause-btn[hidden]{display:none}
        #stop-btn{background:#dc2626}
        #stop-btn[hidden]{display:none}
        pre{margin:6px 0 0;max-width:420px;max-height:320px;overflow:auto;padding:8px;background:#fff;
            color:#222;border:1px solid #ccc;border-radius:6px;white-space:pre-wrap;user-select:text}
      </style>
      <div class="row">
        <button id="check-btn">유튜브 업로드 여부 확인</button>
        <button id="pipeline-btn">모두 업로드</button>
        <button id="pause-btn" hidden>일시정지</button>
        <button id="stop-btn" hidden>중단</button>
      </div>
      <pre hidden></pre>`;
    const checkButton = shadow.getElementById('check-btn');
    const pipelineButton = shadow.getElementById('pipeline-btn');
    const pauseButton = shadow.getElementById('pause-btn');
    const stopButton = shadow.getElementById('stop-btn');
    const out = shadow.querySelector('pre');

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
          return;
        }
        // checkMatch()가 이미 파일 단위로 유튜브 업로드 여부를 판별해뒀다(vod.files[].uploaded,
        // fileOrder 포함) — 다시보기 전체가 미완료(pending)라도 그중 일부 파일은 이미 올라가
        // 있을 수 있으므로, 배치가 그 파일까지 다시 올리지 않도록 videoId별로 넘겨준다.
        const alreadyUploaded = {};
        for (const vod of pending) {
          const orders = (vod.files || []).filter((f) => f.uploaded).map((f) => f.fileOrder);
          if (orders.length > 0) alreadyUploaded[vod.videoId] = orders;
        }
        const res = await chrome.runtime.sendMessage({
          action: 'vodPipeline:start',
          videoIds: pending.map((v) => v.videoId),
          alreadyUploaded,
        });
        if (!res?.success) throw new Error(res?.error || '파이프라인 시작 실패');
        console.log(`${LOG_TAG} 파이프라인 시작: ${res.total}개`, pending.map((v) => v.videoId));
        startWatchingProgress(out, pauseButton, stopButton, pipelineButton);
      } catch (error) {
        out.textContent = `실패: ${error.message}`;
        pipelineButton.disabled = false;
      }
    });

    // 일시정지/재개 — 중단과 달리 진행 상황을 그대로 두고, 다음 파일/다음 다시보기로
    // 넘어가는 것만 멈춘다. 이미 시작된 다운로드/업로드/Studio 자동화는 그대로 진행된다.
    pauseButton.addEventListener('click', async () => {
      const isPaused = pauseButton.dataset.paused === '1';
      pauseButton.disabled = true;
      const res = await chrome.runtime
        .sendMessage({ action: isPaused ? 'vodPipeline:resume' : 'vodPipeline:pause' })
        .catch(() => null);
      if (!res?.success) {
        console.warn(`${LOG_TAG} 일시정지/재개 요청 실패`, res?.error);
      }
      pauseButton.disabled = false;
      // 버튼 라벨 자체는 다음 vodPipeline:status 폴링(최대 3초 이내)에서 실제 상태 기준으로
      // 갱신된다 — 여기서 낙관적으로 바꾸지 않아, 요청이 실패해도 화면이 어긋나지 않는다.
    });

    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true;
      stopButton.textContent = '중단하는 중...';
      await chrome.runtime.sendMessage({ action: 'vodPipeline:stop' }).catch(() => {});
    });

    document.body.appendChild(host);

    // 페이지를 새로고침해도 이미 돌고 있던 파이프라인이 있으면 진행 상황을 이어서 보여준다.
    chrome.runtime.sendMessage({ action: 'vodPipeline:status' }).then((res) => {
      if (res?.state?.running) {
        out.hidden = false;
        pipelineButton.disabled = true;
        startWatchingProgress(out, pauseButton, stopButton, pipelineButton);
      }
    });
  }

  /** vodPipeline:status를 주기적으로 물어 진행 상황을 보여주고, 끝나면 버튼을 되돌린다. */
  function startWatchingProgress(out, pauseButton, stopButton, pipelineButton) {
    pauseButton.hidden = false;
    pauseButton.disabled = false;
    setPauseButtonState(pauseButton, false);
    stopButton.hidden = false;
    stopButton.disabled = false;
    stopButton.textContent = '중단';

    const timer = setInterval(async () => {
      const res = await chrome.runtime.sendMessage({ action: 'vodPipeline:status' }).catch(() => null);
      const state = res?.state;
      if (!state || !state.running) {
        clearInterval(timer);
        pauseButton.hidden = true;
        stopButton.hidden = true;
        pipelineButton.disabled = false;
        if (state) {
          out.textContent = `파이프라인 종료 — 완료 ${state.done.length}개, 실패 ${state.failed.length}개\n` + formatPipelineState(state);
        }
        return;
      }
      setPauseButtonState(pauseButton, Boolean(state.paused));
      out.textContent = formatPipelineState(state);
    }, 3000);
  }

  /** 실제 상태(paused) 기준으로 버튼 라벨/동작을 맞춘다 — 요청 성공 여부와 무관하게 항상 진짜 상태를 따라간다. */
  function setPauseButtonState(pauseButton, paused) {
    pauseButton.dataset.paused = paused ? '1' : '0';
    pauseButton.textContent = paused ? '재개' : '일시정지';
  }

  function formatPipelineState(state) {
    const cur = state.current;
    const curLine = cur
      ? `진행 중: ${cur.videoId}` +
        (Array.isArray(cur.fileOrders)
          ? ` (파일 확인 ${cur.confirmedFileOrders.length + cur.failedFileOrders.length}/${cur.fileOrders.length})`
          : ' (파일 목록 불러오는 중)')
      : '다음 다시보기 준비 중...';
    return [
      state.paused ? '⏸ 일시정지됨 (진행 중인 다운로드/업로드는 그대로 끝까지 진행되고, 다음 단계부터 멈춰 있습니다)' : '',
      curLine,
      `남은 다시보기: ${state.queue.length}개`,
      `완료: ${state.done.length}개 · 실패: ${state.failed.length}개`,
      state.failed.length > 0 ? `[실패 목록]\n${state.failed.map((f) => `${f.videoId} (${f.reason})`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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
