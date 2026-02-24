import { register, getDefinitions, execute, getHandler, getAllHandlers } from './registry';
import { searchFilesHandler } from './handlers/search-files';
import { readFileHandler } from './handlers/read-file';
import { grepHandler } from './handlers/grep';
import { getProjectCommandsHandler } from './handlers/get-project-commands';
import { proposeEditsHandler } from './handlers/propose-edits';
import { searchAndReadHandler } from './handlers/search-and-read';
import { createCompositeToolHandler } from './handlers/create-composite-tool';
import { thinkHandler } from './handlers/think';

// Регистрируем все базовые инструменты
register(searchFilesHandler);
register(readFileHandler);
register(grepHandler);
register(getProjectCommandsHandler);
register(proposeEditsHandler);

// Регистрируем составные инструменты
register(searchAndReadHandler);
register(createCompositeToolHandler);

// Рассуждение
register(thinkHandler);

// Экспортируем для обратной совместимости
export { ToolDefinition, ToolResultWithDiff, ToolContext, ToolHandler } from './types';
export { register, getHandler, getAllHandlers };
export const TOOLS = getDefinitions();
export const executeTool = execute;

// Экспорт для использования в других инструментах
export { searchFilesHandler, readFileHandler, grepHandler };
