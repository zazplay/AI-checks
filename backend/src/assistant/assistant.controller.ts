import { Body, Controller, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AskDto } from './dto/ask.dto';
import { AssistantService, AskResult } from './assistant.service';

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('messages')
  @ApiOperation({ summary: 'Chat with the AI assistant (answers + takes actions)' })
  ask(@Body() dto: AskDto): Promise<AskResult> {
    return this.assistant.ask(dto.message, dto.history, dto.confirm);
  }

  /**
   * Streaming variant of POST /messages. Emits live progress as Server-Sent
   * Events while the agentic loop runs ("thinking", each tool as it executes),
   * then a final `result` event carrying the same AskResult shape, then closes.
   * The body is identical to /messages. Used by the chat UI to show what's
   * happening instead of a mute spinner; non-streaming /messages stays for
   * scripts and the curl smoke test.
   */
  @Post('messages/stream')
  @ApiOperation({ summary: 'Chat with live progress via Server-Sent Events' })
  async askStream(@Body() dto: AskDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await this.assistant.ask(
        dto.message,
        dto.history,
        dto.confirm,
        (step) => send({ type: 'step', step }),
      );
      send({ type: 'result', result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The assistant failed.';
      send({ type: 'error', message });
    } finally {
      res.end();
    }
  }

  @Post('analyze')
  @ApiOperation({ summary: 'AI insights: anomalies + narrative summary over all invoices' })
  analyze() {
    return this.assistant.analyze();
  }

  @Post('invoices/:id/explain')
  @ApiOperation({ summary: 'Plain-language explanation of one invoice' })
  explain(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assistant.explain(id);
  }
}
