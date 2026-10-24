import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AdminAuth, type AdminRequest } from '../tickets/admin-auth';
import { AbacatepaySandboxService } from './abacatepay-sandbox.service';

export class SandboxReceiptDto {
  @IsString() @MinLength(20) @MaxLength(2048) token!: string;
}

@Controller('admin/payments/abacatepay/sandbox')
@UseGuards(AdminAuth)
export class AbacatepaySandboxController {
  constructor(private readonly service: AbacatepaySandboxService) {}
  private json(req: AdminRequest) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new ForbiddenException('Envie JSON.');
  }
  @Get() configuration() { return this.service.configuration(); }
  @Post() create(@Req() req: AdminRequest) { this.json(req); return this.service.create(req.admin.organizationId); }
  @Post('check') check(@Req() req: AdminRequest, @Body() dto: SandboxReceiptDto) { this.json(req); return this.service.check(req.admin.organizationId, dto.token); }
  @Post('simulate') simulate(@Req() req: AdminRequest, @Body() dto: SandboxReceiptDto) { this.json(req); return this.service.simulate(req.admin.organizationId, dto.token); }
}
