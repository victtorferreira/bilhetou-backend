import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
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
