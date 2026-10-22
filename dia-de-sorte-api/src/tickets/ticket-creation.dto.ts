import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class PreviewTicketsDto {
  @IsUUID() campaignId!: string;
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Z][A-Z0-9-]{0,11}$/) prefix!: string;
  @IsBoolean() uniqueNumbers!: boolean;
}

export class ConfirmTicketsDto {
  @IsString() @MaxLength(400000) token!: string;
}

export class TicketStockQueryDto {
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @IsString() @MaxLength(40) query = '';
}
