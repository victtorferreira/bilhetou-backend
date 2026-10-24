import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminAuth, type AdminRequest } from '../tickets/admin-auth';
import { PixPaymentService } from './pix-payment.service';

export class CreatePixPaymentDto {
  @IsUUID() requestKey!: string;
  @IsString() @MinLength(3) @MaxLength(140) description!: string;
  @IsInt() @Min(100) @Max(1000000) amountCents!: number;
}
@Controller('admin/payments/pix')
@UseGuards(AdminAuth)
export class PixPaymentController {
  constructor(private readonly service: PixPaymentService) {}
  private json(req: AdminRequest) { if (!req.headers['content-type']?.startsWith('application/json')) throw new ForbiddenException('Envie JSON.'); }
  @Get('configuration') configuration() { return this.service.configuration(); }
  @Get() list(@Req() req: AdminRequest) { return this.service.list(req.admin.organizationId); }
  @Get(':id') get(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.get(req.admin.organizationId, id); }
  @Post() create(@Req() req: AdminRequest, @Body() dto: CreatePixPaymentDto) { this.json(req); return this.service.create(req.admin.organizationId, dto); }
  @Post(':id/check') check(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { this.json(req); return this.service.check(req.admin.organizationId, id); }
}
@Controller('payments/abacatepay/webhook')
export class PixPaymentWebhookController {
  constructor(private readonly service: PixPaymentService) {}
  @Post() @HttpCode(200)
  receive(@Query('webhookSecret') secret: unknown, @Headers('x-webhook-signature') signature: unknown, @Req() req: { rawBody?: Buffer }, @Body() body: unknown) {
    return this.service.webhook(secret, signature, req.rawBody, body);
  }
}
