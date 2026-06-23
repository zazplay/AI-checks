import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

/**
 * The AI assistant: a Gemini function-calling loop over InvoicesService.
 * GeminiService comes from the global AiModule (shared selected model).
 */
@Module({
  imports: [InvoicesModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
