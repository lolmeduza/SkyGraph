/**
 * Оценка и учёт использования контекста (токенов) для сжатия и передачи в следующий запрос.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextTrackerState {
  usedTokens: number;
  maxTokens: number;
  parts: { role: string; tokens: number }[];
}

export class ContextTracker {
  private usedTokens = 0;
  private maxTokens: number;
  private parts: { role: string; tokens: number }[] = [];

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens;
  }

  add(role: string, content: string): number {
    const tokens = estimateTokens(content);
    this.usedTokens += tokens;
    this.parts.push({ role, tokens });
    return tokens;
  }

  getUsed(): number {
    return this.usedTokens;
  }

  getRemaining(): number {
    return Math.max(0, this.maxTokens - this.usedTokens);
  }

  getMax(): number {
    return this.maxTokens;
  }

  reset(): void {
    this.usedTokens = 0;
    this.parts = [];
  }

  setMax(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  getState(): ContextTrackerState {
    return {
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      parts: [...this.parts],
    };
  }
}
