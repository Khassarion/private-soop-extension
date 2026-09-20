/**
 * Content Script: YouTube Studio 업로드 창 자동 입력
 * VOD 페이지의 "유튜브에 업로드" 버튼이 background를 통해 이 탭에 맡겨둔 제목/설명과
 * 설정 페이지에 저장해둔 옵션(아동용 아님, 재생목록, 공개 범위)을, 사용자가 Studio 업로드
 * 창에서 mp4를 고른 뒤 나타나는 화면에 자동으로 입력/선택한다. 마지막 "저장" 클릭은
 * 사용자가 직접 한다.
 * 백그라운드가 직접 연 탭에서만 동작하며(youtubeStudio:init 응답이 pending일 때),
 * 사용자가 평소에 쓰는 Studio 탭에는 아무 영향이 없다.
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

  // 모든 자동 입력/선택은 반드시 "업로드 창" 안에서만 한다 — 이미 올라간 영상의 편집
  // 화면에도 같은 입력칸이 있어서, 범위를 제한하지 않으면 엉뚱한 영상을 건드릴 수 있다.
  const UPLOAD_DIALOG_SELECTOR = 'ytcp-uploads-dialog';
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

  const DEFAULT_OPTIONS = { visibility: 'unlisted', notForKids: true, playlists: [] };

  let bannerMessageEl = null;

  init();

  async function init() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'youtubeStudio:init' });
    } catch (error) {
      return; // 확장 컨텍스트가 아직 준비되지 않음
    }
    if (!response?.pending) return;

    const options = { ...DEFAULT_OPTIONS, ...(response.options || {}) };
    console.log(`${LOG_TAG} 업로드용 탭으로 확인됨, 자동 입력 대기`, options);
    showBanner(response.title, response.description);
    watchUploadDialog(response.title, response.description, options);
  }

  function watchUploadDialog(title, description, options) {
    const startedAt = Date.now();

    const timer = setInterval(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        setBannerMessage('업로드 창을 찾지 못해 자동 입력을 중단했습니다. 아래 버튼으로 복사해 붙여넣어주세요.', true);
        return;
      }

      const dialog = document.querySelector(UPLOAD_DIALOG_SELECTOR);
      if (!dialog) return;

      const titleBox = findFirst(dialog, TITLE_SELECTORS);
      const descriptionBox = findFirst(dialog, DESCRIPTION_SELECTORS);
      if (!titleBox || !descriptionBox) return;

      clearInterval(timer);
      console.log(`${LOG_TAG} 업로드 창의 제목/설명 입력칸 발견, 자동 입력 시작`);
      await runAutomation(dialog, titleBox, descriptionBox, title, description, options);
    }, POLL_INTERVAL_MS);
  }

  async function runAutomation(dialog, titleBox, descriptionBox, title, description, options) {
    const results = [];
    const report = () => setBannerMessage(formatResults(results, true));

    setBannerMessage('제목/설명을 입력하는 중...');
    const [titleOk, descriptionOk] = await Promise.all([
      fillWithVerify(titleBox, title),
      fillWithVerify(descriptionBox, description),
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
    await sleep(600); // 목록 렌더링 대기

    const missing = [];
    for (const name of names) {
      const row = findPlaylistRow(popup, name);
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

  function findPlaylistRow(root, name) {
    const target = normalize(name);
    const rows = Array.from(root.querySelectorAll('li'));
    const candidates = rows.length > 0 ? rows : Array.from(root.querySelectorAll('ytcp-checkbox-lit'));
    // 정확히 같은 이름만 인정한다 — 부분 일치를 허용하면 비슷한 이름의 다른 재생목록에
    // 조용히 들어가 버릴 수 있다.
    return candidates.find((row) => rowHasText(row, target)) || null;
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

  function showBanner(title, description) {
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
      </style>
      <div class="banner">
        <div class="top"><strong>🎬 VOD 업로드 도우미</strong><button class="close" id="close" title="닫기">×</button></div>
        <p class="message" id="message">업로드 창에서 mp4 파일을 선택하면 제목/설명과 설정해둔 옵션을 자동으로 채워드립니다.</p>
        <div class="actions">
          <button class="copy" id="copyTitle">제목 복사</button>
          <button class="copy" id="copyDescription">설명 복사</button>
        </div>
      </div>`;

    bannerMessageEl = shadowRoot.getElementById('message');
    shadowRoot.getElementById('close').addEventListener('click', () => host.remove());
    bindCopyButton(shadowRoot.getElementById('copyTitle'), title, '제목 복사');
    bindCopyButton(shadowRoot.getElementById('copyDescription'), description, '설명 복사');
  }

  function bindCopyButton(button, text, label) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
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
