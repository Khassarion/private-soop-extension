/**
 * Content Script: 오늘의 포인트 미션 현황 패널
 * Soop 페이지 한쪽 구석에 작은 패널을 띄워, mypoint 상세내역 페이지에 가지 않아도
 * 오늘 어떤 활동이 부족한지 한눈에 볼 수 있게 한다.
 */

(() => {
  const HOST_ID = 'private-extension-point-status-host';

  chrome.storage.local.get(['settings']).then(({ settings }) => {
    if (settings?.features?.pointStatus?.enabled === false) return;
    initPanel();
  });

  function initPanel() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;';
    document.documentElement.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { width: 300px; max-height: calc(100vh - 40px); overflow-y: auto; padding: 14px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.2); font: 13px/1.4 Arial, sans-serif; }
        .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; cursor: pointer; user-select: none; }
        h1 { margin: 0; font-size: 14px; color: #374151; white-space: nowrap; }
        .header-actions { display: flex; align-items: center; gap: 6px; }
        .icon-button { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: #f1f5f9; color: #475569; cursor: pointer; font-size: 13px; line-height: 1; }
        .icon-button:hover { background: #e2e8f0; }
        .panel.collapsed { width: auto; padding: 8px 10px; }
        .panel.collapsed .body { display: none; }
        .summary-badge { font-size: 12px; color: #667eea; font-weight: 600; white-space: nowrap; }
        .body { margin-top: 12px; }
        .category { margin-bottom: 12px; }
        .category:last-child { margin-bottom: 0; }
        .category-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
        .category-name { font-weight: 700; font-size: 13px; color: #333; }
        .category-score { font-size: 12px; color: #6b7280; }
        .category-score.complete { color: #16a34a; }
        .category-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-bottom: 6px; }
        .category-bar-fill { height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); }
        .detail-list { list-style: none; display: flex; flex-direction: column; gap: 3px; }
        .detail-item { display: flex; justify-content: space-between; padding: 3px 6px; border-radius: 4px; font-size: 12px; }
        .detail-item.incomplete { background: #fef3f2; color: #b91c1c; }
        .detail-item.complete { color: #9ca3af; }
        .detail-item.complete .detail-name::before { content: '✓ '; }
        .message { font-size: 12px; color: #6b7280; text-align: center; padding: 8px 0; }
        .message.error { color: #dc2626; }
      </style>
      <div class="panel collapsed">
        <div class="panel-header" id="header">
          <h1>🎯 오늘의 포인트</h1>
          <div class="header-actions">
            <span class="summary-badge" id="summaryBadge"></span>
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
    const summaryBadge = shadowRoot.getElementById('summaryBadge');

    header.addEventListener('click', (event) => {
      if (event.target === refreshButton) return;
      const wasCollapsed = panelElement.classList.contains('collapsed');
      panelElement.classList.toggle('collapsed');
      if (wasCollapsed) loadPointStatus(contentEl, summaryBadge);
    });

    refreshButton.addEventListener('click', (event) => {
      event.stopPropagation();
      loadPointStatus(contentEl, summaryBadge);
    });

    loadPointStatus(contentEl, summaryBadge);
  }

  async function loadPointStatus(contentEl, summaryBadge) {
    contentEl.innerHTML = '<p class="message">불러오는 중...</p>';
    summaryBadge.textContent = '';

    let response;
    try {
      response = await chrome.runtime.sendMessage({ action: 'pointStatus:fetch' });
    } catch (error) {
      contentEl.innerHTML = '<p class="message error">확장 프로그램과 통신할 수 없습니다.</p>';
      return;
    }

    if (!response?.success) {
      contentEl.innerHTML = `<p class="message error">${escapeHtml(response?.error || '포인트 정보를 가져오지 못했습니다.')}</p>`;
      return;
    }

    renderCategories(contentEl, summaryBadge, response.data);
  }

  function renderCategories(contentEl, summaryBadge, data) {
    const categories = Object.values(data || {});
    if (categories.length === 0) {
      contentEl.innerHTML = '<p class="message">표시할 포인트 정보가 없습니다.</p>';
      return;
    }

    let totalPoint = 0;
    let totalMaxPoint = 0;

    contentEl.innerHTML = '';
    categories.forEach((category) => {
      totalPoint += category.POINT || 0;
      totalMaxPoint += category.MAX_POINT || 0;
      contentEl.appendChild(renderCategory(category));
    });

    summaryBadge.textContent = `${totalPoint}/${totalMaxPoint}`;
  }

  function renderCategory(category) {
    const isComplete = category.POINT >= category.MAX_POINT;
    const percent = category.MAX_POINT > 0 ? Math.min(100, (category.POINT / category.MAX_POINT) * 100) : 100;

    const details = Object.values(category.DETAIL || {}).sort((a, b) => {
      const aComplete = a.COUNT >= a.MAX_COUNT ? 1 : 0;
      const bComplete = b.COUNT >= b.MAX_COUNT ? 1 : 0;
      return aComplete - bComplete;
    });

    const el = document.createElement('div');
    el.className = 'category';
    el.innerHTML = `
      <div class="category-header">
        <span class="category-name"></span>
        <span class="category-score${isComplete ? ' complete' : ''}"></span>
      </div>
      <div class="category-bar"><div class="category-bar-fill" style="width:${percent}%"></div></div>
      <ul class="detail-list"></ul>
    `;

    el.querySelector('.category-name').textContent = category.NAME;
    el.querySelector('.category-score').textContent = `${category.POINT}/${category.MAX_POINT}`;

    const list = el.querySelector('.detail-list');
    details.forEach((detail) => {
      const detailComplete = detail.COUNT >= detail.MAX_COUNT;
      const item = document.createElement('li');
      item.className = `detail-item ${detailComplete ? 'complete' : 'incomplete'}`;
      item.innerHTML = '<span class="detail-name"></span><span class="detail-count"></span>';
      item.querySelector('.detail-name').textContent = detail.NAME;
      item.querySelector('.detail-count').textContent = `${detail.COUNT}/${detail.MAX_COUNT}`;
      list.appendChild(item);
    });

    return el;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
