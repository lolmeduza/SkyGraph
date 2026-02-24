import * as vscode from 'vscode';

export interface ToolContext {
  proposeEditsAttempt?: number;
}

export interface ToolResultWithDiff {
  result: string;
  diffPayload?: {
    files: {
      path: string;
      originalContent: string;
      proposedContent: string;
    }[];
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    workspaceUri: vscode.Uri,
    context?: ToolContext
  ): Promise<string | ToolResultWithDiff>;
}
