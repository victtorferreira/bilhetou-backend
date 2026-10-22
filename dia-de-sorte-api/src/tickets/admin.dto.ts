import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
export class CreateCampaignDto {
  @IsString() @MinLength(3) @MaxLength(120) name!: string;
  @IsInt() @Min(1) @Max(100000000) ticketPriceCents!: number;
  @IsOptional() @IsInt() @Min(0) @Max(2000000000) prizeCents?: number;
  @IsIn(['DRAFT', 'OPEN']) status!: 'DRAFT' | 'OPEN';
  @IsOptional() @IsISO8601() closesAt?: string;
}
export class AdminLoginDto { @IsString() @MaxLength(512) secret!: string; }
export class ImportRowDto {
  @IsString() @MaxLength(100) serial!: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(100, { each: true }) numbers!: string[];
  @IsOptional() @IsInt() @Min(1) line?: number;
}
export class ImportTicketsDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2500) @ValidateNested({ each: true }) @Type(() => ImportRowDto) rows!: ImportRowDto[]; }
export class CheckDrawDto {
  @IsString() @Matches(/^[0-9]{4}$/) number!: string;
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/) reference!: string;
}
export class NumberSearchDto { @IsString() @Matches(/^[0-9]{4}$/) number!: string; }
