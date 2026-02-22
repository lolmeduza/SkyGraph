# План: фабрика ручек для LLM

## Цель

Сделать инструменты (ручки) расширяемыми и дать модели возможность эффективно их комбинировать: либо цепочкой вызовов (как сейчас), либо через составные ручки (один вызов = несколько шагов).

---

## 1. Текущее состояние

- В `llm/tools.ts`: массив `TOOLS` (ToolDefinition[]) и `executeTool(call, workspaceUri, context)` с ветками `if (name === 'search_files')` и т.д.
- Модель уже комбинирует вызовы по цепочке: search_files → read_file → propose_edits. Ограничения: жёсткий список инструментов, добавление нового = правки в нескольких местах.

---

## 2. Реестр ручек (фабрика)

### 2.1 Интерфейс одной ручки

```ts
interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema для function.parameters
  execute(
    args: Record<string, unknown>,
    workspaceUri: vscode.Uri,
    context?: ToolContext
  ): Promise<string | ToolResultWithDiff>;
}
```

- Одна ручка = один инструмент для LLM: имя, описание, схема аргументов, функция выполнения.

### 2.2 Реестр

- `register(handler: ToolHandler): void` — добавить ручку.
- `getDefinitions(): ToolDefinition[]` — список для API (то, что уходит в `tools`).
- `execute(name: string, call: LLMToolCall, workspaceUri, context): Promise<string | ToolResultWithDiff>` — выполнить по имени через реестр, без `if (name === '...')`.

### 2.3 Разделение по файлам

- `src/llm/tools/` (или `src/tools/`):
  - `types.ts` — ToolHandler, ToolContext, ToolResultWithDiff, ToolDefinition (если нужно переиспользовать).
  - `registry.ts` — реестр: register, getDefinitions, execute.
  - `handlers/search-files.ts`, `read-file.ts`, `grep.ts`, `propose-edits.ts` — по одному файлу на ручку, каждый экспортирует объект ToolHandler.
  - `index.ts` — регистрирует все ручки, экспортирует `TOOLS` и `executeTool` для обратной совместимости с `llm/index.ts`.

Итог: добавление новой ручки = новый файл + одна строка регистрации. LLM по-прежнему комбинирует вызовы цепочкой, но набор инструментов управляется из одного места.

---

## 3. Как LLM будет комбинировать ручки

### Вариант A (базовый): только реестр

- Модель получает все зарегистрированные инструменты и сама решает порядок: search_files → read_file → propose_edits. Ничего не меняем в поведении, только в способе определения инструментов.

### Вариант B: составные ручки (composed tools)

- В реестр добавляются ручки, которые внутри вызывают другие ручки.
- Примеры:
  - `search_and_read`: аргументы `query`, `maxFiles`; внутри: search_files(query) → по топ-N путям read_file → склеить результат в один текст. Один вызов от модели вместо двух–трёх.
  - `grep_then_read`: pattern + glob → grep → по списку совпадений прочитать файлы (дедуп по path), вернуть контекст.
- Плюс: меньше раундов, меньше токенов на историю. Минус: больше инструментов в списке, нужно чётко описать в description, когда использовать составной, а когда простой.

### Вариант C: динамический набор ручек

- По типу задачи (из системного промпта или из первого сообщения) выбираем подмножество ручек и в запрос к API передаём только их.
- Пример: для задачи «только поиск» отдаём search_files + read_file; для «правки кода» — все четыре. Так можно уменьшить размер блока `tools` и подсказать модели релевантный набор.

Рекомендация: начать с варианта A (реестр), затем при необходимости добавить 1–2 составные ручки (B) и опционально — выбор набора по задаче (C).

---

## 4. Этапы реализации

| Этап | Что делаем |
|------|------------|
| 1 | Вынести типы (ToolHandler, ToolContext, ToolResultWithDiff) в `tools/types.ts`. |
| 2 | Реестр в `tools/registry.ts`: register, getDefinitions, execute. |
| 3 | Перенести текущие 4 инструмента в отдельные файлы-ручки и зарегистрировать их. |
| 4 | Заменить в `llm/tools.ts` (или в `llm/index.ts`) использование: TOOLS = getDefinitions(), executeTool = (call, uri, ctx) => registry.execute(call.function.name, call, uri, ctx). |
| 5 | (Опционально) Добавить 1–2 составные ручки и зарегистрировать их. |
| 6 | (Опционально) Реализовать выбор подмножества ручек по задаче и передавать его в chatWithTools. |

---

## 5. Зависимости и обратная совместимость

- `llm/index.ts`: продолжает получать `TOOLS` и вызывать один `executeTool`; источник — реестр.
- `runValidation`, `getIndex`, vscode API остаются теми же; их вызывают конкретные ручки (propose_edits, search_files и т.д.).
- Контекст (proposeEditsAttempt и т.п.) по-прежнему передаётся в execute и при необходимости в отдельные ручки.

После этого план можно уточнять (например, какие именно составные ручки нужны первыми) и переходить к коду по этапам.
