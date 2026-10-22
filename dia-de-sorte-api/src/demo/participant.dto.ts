import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class RegisterParticipantDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(30) phone!: string;
}
export class ParticipantSelectionDto {
  @ValidateIf(o => o.ticketIds !== undefined || o.quantity === undefined)
  @IsArray() @ArrayMaxSize(1000) @ArrayUnique() @IsUUID('all', { each: true }) ticketIds?: string[];
  @ValidateIf(o => o.quantity !== undefined || o.ticketIds === undefined)
  @IsInt() @Min(1) @Max(1000) quantity?: number;
}
export class ParticipantCampaignDto { @IsUUID() campaignId!: string; }
export class ParticipantOrderDto { @IsUUID() idempotencyKey!: string; }
export class ParticipantTicketQueryDto {
  @Transform(({ value }: { value: unknown }) => Number(value)) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @IsString() @MaxLength(40) query = '';
  @IsOptional() @IsString() @MaxLength(5) selectedOnly = 'false';
}
