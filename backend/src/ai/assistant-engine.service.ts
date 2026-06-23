import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiService } from './gemini.service';
import { GroqService } from './groq.service';
import { ClaudeService } from './claude.service';

export type AssistantProvider = 'gemini' | 'groq' | 'claude';

export interface EngineChoice {
  provider: AssistantProvider;
  model: string;
}

export interface EngineOption {
  provider: AssistantProvider;
  model: string;
  available: boolean;
}

/**
 * Holds the assistant's currently-selected engine (provider + model), which is
 * INDEPENDENT of the extraction model. Extraction always uses Gemini's vision
 * model (managed by GeminiService); the chat assistant can run on Gemini or on
 * Groq's far-larger free quota. The UI engine switcher drives this.
 */
@Injectable()
export class AssistantEngineService {
  private readonly logger = new Logger(AssistantEngineService.name);
  private current: EngineChoice;

  constructor(
    config: ConfigService,
    private readonly gemini: GeminiService,
    private readonly groq: GroqService,
    private readonly claude: ClaudeService,
  ) {
    // Honour an explicit preference; otherwise default to Groq (big free quota),
    // then Claude, then Gemini, by availability.
    const preferred = config.get<string>('ASSISTANT_PROVIDER') as
      | AssistantProvider
      | undefined;
    if (preferred === 'claude' && this.claude.available) {
      this.current = { provider: 'claude', model: this.claude.model };
    } else if ((preferred === 'groq' || !preferred) && this.groq.available) {
      this.current = { provider: 'groq', model: this.groq.defaultModel };
    } else if (preferred === 'gemini' || !this.claude.available) {
      this.current = { provider: 'gemini', model: this.gemini.model };
    } else {
      this.current = { provider: 'claude', model: this.claude.model };
    }
    this.logger.log(
      `Assistant engine: ${this.current.provider} / ${this.current.model}`,
    );
  }

  get choice(): EngineChoice {
    return this.current;
  }

  /** Every selectable engine across both providers, with availability flags. */
  listOptions(): EngineOption[] {
    const options: EngineOption[] = this.gemini
      .listModels()
      .map((model) => ({ provider: 'gemini' as const, model, available: !!this.gemini.client }));
    for (const model of this.groq.listModels()) {
      options.push({ provider: 'groq', model, available: this.groq.available });
    }
    // Claude is Haiku-only (a single model).
    options.push({ provider: 'claude', model: this.claude.model, available: this.claude.available });
    return options;
  }

  select(provider: AssistantProvider, model: string): EngineChoice {
    if (provider === 'gemini') {
      if (!(this.gemini.listModels() as readonly string[]).includes(model)) {
        throw new BadRequestException(`Unknown Gemini model "${model}".`);
      }
      if (!this.gemini.client) {
        throw new BadRequestException('Gemini is not configured (missing GEMINI_API_KEY).');
      }
    } else if (provider === 'groq') {
      if (!this.groq.isValidModel(model)) {
        throw new BadRequestException(`Unknown Groq model "${model}".`);
      }
      if (!this.groq.available) {
        throw new BadRequestException('Groq is not configured (missing GROQ_API_KEY).');
      }
    } else if (provider === 'claude') {
      if (model !== this.claude.model) {
        throw new BadRequestException(`Claude only supports "${this.claude.model}".`);
      }
      if (!this.claude.available) {
        throw new BadRequestException('Claude is not configured (missing ANTHROPIC_API_KEY).');
      }
    } else {
      throw new BadRequestException(`Unknown provider "${String(provider)}".`);
    }

    this.current = { provider, model };
    this.logger.log(`Assistant engine switched to ${provider} / ${model}`);
    return this.current;
  }
}
