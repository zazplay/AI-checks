import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude is used ONLY via Haiku 4.5 (`claude-haiku-4-5`) — the fastest, cheapest
 * Claude model. It powers two roles:
 *  - an alternate assistant chat engine (tool use / function calling), and
 *  - a vision fallback in the extraction cascade (Haiku reads PDFs and images).
 * The model is fixed; there is no model switcher for Claude.
 */
export const CLAUDE_MODEL = 'claude-haiku-4-5';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  readonly client: Anthropic | null;
  readonly model = CLAUDE_MODEL;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.log('ANTHROPIC_API_KEY not set — Claude (Haiku) engine disabled.');
    }
  }

  get available(): boolean {
    return this.client !== null;
  }

  /** Turn raw Anthropic SDK errors into a short, user-facing message. */
  humanizeError(error: unknown): string {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    const raw =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const lower = raw.toLowerCase();

    if (status === 429 || lower.includes('rate limit') || lower.includes('overloaded')) {
      return 'Claude rate limit hit — please retry in a moment or switch model.';
    }
    if (status === 401 || status === 403) {
      return 'Claude rejected the request (check ANTHROPIC_API_KEY).';
    }
    if (status && status >= 500) {
      return 'The Claude service is temporarily unavailable. Please retry.';
    }
    return `Claude request failed: ${raw.slice(0, 160)}`;
  }
}
