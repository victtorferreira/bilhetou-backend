import { Body, Controller, Header, Headers, HttpCode, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { ParticipantOriginGuard } from '../participants/participant.controller';
import { ParticipantService } from '../participants/participant.service';
import { ZettpayService } from './zettpay.service';
export class ZettpayPayerDto {
  @IsEmail() @MaxLength(254) payerEmail!: string;
  @IsString() @MaxLength(30) payerDocument!: string;
}
interface Request { headers: Record<string, string | undefined> }
@Controller('participant/orders/:id/payment')
@UseGuards(ParticipantOriginGuard)
export class ZettpayCheckoutController {
  constructor(private readonly payments: ZettpayService, private readonly participants: ParticipantService) {}
  private token(req: Request) { return this.participants.token(req.headers.cookie); }
  @Get() @Header('Cache-Control', 'private, no-store') current(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.payments.current(this.token(req), id); }
  @Post() @Header('Cache-Control', 'private, no-store') create(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ZettpayPayerDto) { return this.payments.create(this.token(req), id, dto); }
  @Post('check') @Header('Cache-Control', 'private, no-store') check(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.payments.check(this.token(req), id); }
}
@Controller('payments/zettpay/webhook')
export class ZettpayWebhookController {
  constructor(private readonly payments: ZettpayService) {}
  @Post() @HttpCode(200)
  webhook(@Headers('x-webhook-signature') signature: unknown, @Req() req: { rawBody?: Buffer }, @Body() body: unknown) { return this.payments.webhook(signature, req.rawBody, body); }
}
