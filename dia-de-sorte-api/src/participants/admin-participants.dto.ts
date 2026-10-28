import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class AdminParticipantPageDto {
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt() @Min(1) @Max(100000) page = 1;
}

export class AdminParticipantQueryDto extends AdminParticipantPageDto {
  @IsOptional() @IsString() @MaxLength(120) query = '';
  @IsOptional() @IsIn(['all', 'with_orders', 'without_orders']) activity = 'all';
  @IsOptional() @IsUUID() campaignId?: string;
  @IsOptional() @IsIn(['current', 'all']) campaignScope = 'current';
}
