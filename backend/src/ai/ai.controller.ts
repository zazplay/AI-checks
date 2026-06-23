import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import {
  AssistantEngineService,
  type AssistantProvider,
} from './assistant-engine.service';
import { ExtractionEngineService } from './extraction-engine.service';

class SetModelDto {
  @IsString()
  model: string;
}

class SetEngineDto {
  @IsIn(['gemini', 'groq', 'claude'])
  provider: AssistantProvider;

  @IsString()
  model: string;
}

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(
    private readonly extraction: ExtractionEngineService,
    private readonly engine: AssistantEngineService,
  ) {}

  @Get('models')
  @ApiOperation({ summary: 'List selectable extraction engines (Claude + Gemini) and the current one' })
  list() {
    return { current: this.extraction.model, available: this.extraction.listModels() };
  }

  @Put('model')
  @ApiOperation({ summary: 'Switch the PRIMARY extraction engine (Claude Haiku or a Gemini model)' })
  setModel(@Body() dto: SetModelDto) {
    return {
      current: this.extraction.setModel(dto.model),
      available: this.extraction.listModels(),
    };
  }

  @Get('assistant-engine')
  @ApiOperation({ summary: 'Current assistant engine + all selectable engines' })
  engineOptions() {
    return { current: this.engine.choice, options: this.engine.listOptions() };
  }

  @Put('assistant-engine')
  @ApiOperation({ summary: 'Switch the assistant engine (Gemini or Groq)' })
  setEngine(@Body() dto: SetEngineDto) {
    return {
      current: this.engine.select(dto.provider, dto.model),
      options: this.engine.listOptions(),
    };
  }
}
