import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

/** Free-tier Gemini models that support text + vision + function calling. */
export const AVAILABLE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
] as const;

/**
 * Thin shared wrapper around the Gemini client. Holds the *currently selected*
 * model (mutable, default from env) so the in-app model switcher affects BOTH
 * extraction and the assistant. Mirrors the client construction that used to
 * live in ExtractionService.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  readonly client: GoogleGenAI | null;
  private currentModel: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('GEMINI_API_KEY');
    this.currentModel = config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('GEMINI_API_KEY is not set — AI features will fail.');
    }
  }

  get model(): string {
    return this.currentModel;
  }

  listModels(): readonly string[] {
    return AVAILABLE_MODELS;
  }

  setModel(model: string): string {
    if (!(AVAILABLE_MODELS as readonly string[]).includes(model)) {
      throw new BadRequestException(
        `Unknown model "${model}". Allowed: ${AVAILABLE_MODELS.join(', ')}.`,
      );
    }
    this.currentModel = model;
    this.logger.log(`AI model switched to ${model}`);
    return model;
  }

  /** Turn raw Gemini SDK errors into a short, user-facing message. */
  humanizeError(error: unknown): string {
    const raw =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const code = /\b(429|400|403|500|503)\b/.exec(raw)?.[1];
    const lower = raw.toLowerCase();

    if (code === '429' || lower.includes('quota') || lower.includes('rate limit')) {
      return 'AI quota exceeded — too many requests. Please retry in a minute or switch model.';
    }
    if (code === '403') return 'AI request was rejected (check the API key).';
    if (code && ['500', '503'].includes(code)) {
      return 'The AI service is temporarily unavailable. Please retry.';
    }
    return `AI request failed: ${raw.slice(0, 160)}`;
  }
}
