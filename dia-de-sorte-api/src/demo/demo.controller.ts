import { Body, Controller, Post } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { DemoService } from './demo.service';
class SimulateDto {
  @IsUUID() campaignId!: string;
  @IsInt() @Min(1) @Max(10) quantity!: number;
}
@Controller('demo')
export class DemoController {
  constructor(private readonly service: DemoService) {}
  @Post('orders')
  create(@Body() dto: SimulateDto) { return this.service.create(dto.campaignId, dto.quantity); }
}
