import { Global, Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { GeminiService } from './gemini.service';
import { GroqService } from './groq.service';
import { ClaudeService } from './claude.service';
import { AssistantEngineService } from './assistant-engine.service';
import { ExtractionEngineService } from './extraction-engine.service';

/**
 * Global so the single shared services are reused everywhere:
 * - GeminiService holds the extraction model (also a valid assistant engine).
 * - GroqService is the alternate, bigger-quota assistant engine.
 * - AssistantEngineService tracks which engine the assistant currently uses
 *   (independent of extraction).
 */
@Global()
@Module({
  controllers: [AiController],
  providers: [
    GeminiService,
    GroqService,
    ClaudeService,
    AssistantEngineService,
    ExtractionEngineService,
  ],
  exports: [
    GeminiService,
    GroqService,
    ClaudeService,
    AssistantEngineService,
    ExtractionEngineService,
  ],
})
export class AiModule {}
