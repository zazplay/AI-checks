import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiService } from './gemini.service';
import { ClaudeService } from './claude.service';

/**
 * Holds the user-selected PRIMARY extraction engine — the one tried FIRST on
 * upload. By default this is Claude Haiku (vision: reads PDFs and images); the
 * other engines (Gemini models, GPT-from-PDF-text) act as fallbacks in the
 * cascade. Switching it (via the extraction-model selector) only changes which
 * engine leads — the cascade still backs it up.
 *
 * The selection is a single model string: `claude-haiku-4-5` or one of the
 * Gemini vision models. Setting a Gemini model ALSO sets it as Gemini's active
 * model (so the cascade's Gemini attempt uses the chosen one).
 */
@Injectable()
export class ExtractionEngineService {
  private readonly logger = new Logger(ExtractionEngineService.name);
  private currentModel: string;

  constructor(
    config: ConfigService,
    private readonly gemini: GeminiService,
    private readonly claude: ClaudeService,
  ) {
    // Default to Claude Haiku when available; else fall back to Gemini's model.
    const preferred = config.get<string>('EXTRACTION_MODEL');
    if (preferred && this.isValid(preferred)) {
      this.currentModel = preferred;
    } else if (this.claude.available) {
      this.currentModel = this.claude.model;
    } else {
      this.currentModel = this.gemini.model;
    }
    this.logger.log(`Primary extraction engine: ${this.currentModel}`);
  }

  /** The currently-selected primary extraction model id. */
  get model(): string {
    return this.currentModel;
  }

  /** True when the selected primary engine is Claude Haiku. */
  get isClaude(): boolean {
    return this.currentModel === this.claude.model;
  }

  /** Every selectable extraction model: Claude Haiku + the Gemini vision models. */
  listModels(): string[] {
    const models: string[] = [];
    if (this.claude.available) models.push(this.claude.model);
    models.push(...this.gemini.listModels());
    return models;
  }

  private isValid(model: string): boolean {
    return (
      model === this.claude.model ||
      (this.gemini.listModels() as readonly string[]).includes(model)
    );
  }

  setModel(model: string): string {
    if (model === this.claude.model) {
      if (!this.claude.available) {
        throw new BadRequestException('Claude is not configured (missing ANTHROPIC_API_KEY).');
      }
      this.currentModel = model;
    } else if ((this.gemini.listModels() as readonly string[]).includes(model)) {
      if (!this.gemini.client) {
        throw new BadRequestException('Gemini is not configured (missing GEMINI_API_KEY).');
      }
      // Picking a Gemini model also makes it Gemini's active model.
      this.gemini.setModel(model);
      this.currentModel = model;
    } else {
      throw new BadRequestException(`Unknown extraction model "${model}".`);
    }
    this.logger.log(`Primary extraction engine switched to ${this.currentModel}`);
    return this.currentModel;
  }
}
