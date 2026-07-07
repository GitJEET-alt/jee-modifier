import { ProcessedQuestion } from './types';

const DISABLED_MESSAGE =
  'The legacy standalone Gemini service is disabled. Use the Next.js app in jee-modifier-next, which routes AI calls through the PW proxy.';

export class GeminiProcessor {
  async startSession(): Promise<number> {
    throw new Error(DISABLED_MESSAGE);
  }

  async processBatch(): Promise<ProcessedQuestion[]> {
    throw new Error(DISABLED_MESSAGE);
  }
}
