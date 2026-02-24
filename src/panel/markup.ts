import { getPanelScript } from './panel-script';

/** Равномерно распределённые позиции для звёзд (процент от ширины/высоты) */
function starPositions(count: number): { left: number; top: number }[] {
  const out: { left: number; top: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      left: ((i * 17 + 3) % 97) + 1,
      top: ((i * 23 + 11) % 94) + 2,
    });
  }
  return out;
}

export function getPanelMarkup(): string {
  const stars = starPositions(55)
    .map(
      (p, i) =>
        `<span class="star" style="left:${p.left}%;top:${p.top}%;animation-delay:${(i % 30) * 0.15}s;--scale:${0.5 + (i % 3) * 0.35}"></span>`
    )
    .join('');
  return `
  <div id="starfield-overlay" class="starfield-overlay" aria-hidden="true">
    <div class="starfield-bg"></div>
    <div class="starfield-stars">${stars}</div>
    <div class="starfield-title">Sky Graph</div>
  </div>
  <div class="wrapper">
    <div class="tabs-row">
      <div class="tabs" id="chatTabs"></div>
      <div class="tabs-actions">
        <button class="tab clear-chat-btn" id="clearChatBtn" title="Очистить чат с LLM" style="display: none;">Очистить чат</button>
        <button class="tab tab-history" id="historyBtn" title="История чатов">История</button>
        <div class="history-dropdown" id="historyDropdown"></div>
      </div>
    </div>
    <div class="container">
      <div class="panel-body">
        <div class="messages" id="messages"></div>
        <div class="diff-view" id="diffView" style="display: none;">
          <div class="diff-view-header">Предложенные правки (красный — удалено, зелёный — добавлено). При проверке файлы временно подменяются, затем восстанавливаются.</div>
          <div class="diff-view-summary" id="diffViewSummary"></div>
          <div class="diff-view-files" id="diffViewFiles"></div>
          <div class="diff-view-actions">
            <button class="diff-apply-btn" id="diffApplyBtn">Применить</button>
            <button class="diff-reject-btn" id="diffRejectBtn">Отклонить</button>
          </div>
        </div>
      </div>
      <div class="input-container">
        <div class="file-insert-toast" id="fileInsertToast" style="display: none;"></div>
        <div class="input-row">
          <textarea id="input" placeholder="Запрос (Enter — новая строка, Ctrl+Enter — отправить)" rows="2"></textarea>
          <button class="send-btn" id="sendBtn">Отправить</button>
        </div>
        <div class="context-footer" id="contextFooter"></div>
      </div>
    </div>
  </div>
  <script>
${getPanelScript()}
  </script>
`;
}
