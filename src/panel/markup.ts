import { getPanelScript } from './panel-script';

export function getPanelMarkup(): string {
  return `
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
