import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'model'] })
  @IsIn(['user', 'model'])
  role: 'user' | 'model';

  @ApiProperty()
  @IsString()
  content: string;
}

export class ConfirmDto {
  @ApiProperty({ description: 'Signed token returned in pendingConfirmation' })
  @IsString()
  token: string;
}

export class AskDto {
  @ApiProperty({ example: 'How many invoices failed?' })
  @IsString()
  message: string;

  @ApiPropertyOptional({ type: [ChatTurnDto], description: 'Prior conversation turns' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];

  @ApiPropertyOptional({ type: ConfirmDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ConfirmDto)
  confirm?: ConfirmDto;
}
