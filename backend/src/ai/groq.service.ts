import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/**
 * Groq production models that reliably support tool/function calling. Groq's
 * free tier is far more generous than Gemini's (~14.4k requests/day, no card),
 * which makes it a good fit for the chat assistant (text + function calling).
 * It has no/weak vision, so extraction stays on Gemini — this service powers
 * the assistant only.
 */
export const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'moonshotai/kimi-k2-instruct',
  'qwen/qwen3-32b',
] as const;

/**
 * Thin wrapper around Groq's OpenAI-compatible API. Mirrors GeminiService so the
 * assistant can use either engine. The client is null when no GROQ_API_KEY is
 * set, in which case Groq simply isn't offered as an assistant engine.
 */
@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  readonly client: OpenAI | null;
  readonly defaultModel: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('GROQ_API_KEY');
    this.defaultModel = config.get<string>('GROQ_MODEL') ?? GROQ_MODELS[0];
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })
      : null;
    if (!this.client) {
      this.logger.log('GROQ_API_KEY not set — Groq assistant engine disabled.');
    }
  }

  get available(): boolean {
    return this.client !== null;
  }

  listModels(): readonly string[] {
    return GROQ_MODELS;
  }

  isValidModel(model: string): boolean {
    return (GROQ_MODELS as readonly string[]).includes(model);
  }

  /** Turn raw Groq/OpenAI SDK errors into a short, user-facing message. */
  humanizeError(error: unknown): string {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    const raw =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const lower = raw.toLowerCase();

    if (status === 429 || lower.includes('rate limit') || lower.includes('quota')) {
      return 'Groq rate limit hit — please retry in a moment or switch model.';
    }
    if (status === 401 || status === 403) {
      return 'Groq rejected the request (check GROQ_API_KEY).';
    }
    if (status && status >= 500) {
      return 'The Groq service is temporarily unavailable. Please retry.';
    }
    return `Groq request failed: ${raw.slice(0, 160)}`;
  }
}
