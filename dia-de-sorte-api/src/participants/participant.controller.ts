import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { ParticipantCampaignDto, ParticipantOrderDto, ParticipantSelectionDto, ParticipantTicketQueryDto, RegisterParticipantDto } from './participant.dto';
import { allowedOrigins } from '../security/origins';

interface Request { method: string; headers: Record<string, string | undefined> }
interface Response { setHeader(name: string, value: string | string[]): void }
@Injectable()
export class ParticipantOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.origin && !allowedOrigins().includes(request.headers.origin)) throw new ForbiddenException('Origem não permitida.');
    if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) throw new ForbiddenException('Envie JSON.');
    return true;
  }
}
// Keep the former prefix temporarily so existing deployments can upgrade their cookies.
@Controller(['participant', 'demo'])
@UseGuards(ParticipantOriginGuard)
export class ParticipantController {
  constructor(private readonly service: ParticipantService) {}
  private token(req: Request, res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.service.token(req.headers.cookie); }
  @Get('session') async current(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.token(req, res);
    const state = await this.service.current(token);
    if (token && state.participant) res.setHeader('Set-Cookie', [this.service.cookie(token), this.legacyCookie()]);
    return state;
  }
  private legacyCookie() { return `bilhetou_participant=; HttpOnly; SameSite=Strict; Path=/api/demo; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
  @Post('session') async register(@Body() dto: RegisterParticipantDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, state } = await this.service.register(dto.name, dto.phone, this.token(req, res), dto.whatsappConsent);
    res.setHeader('Set-Cookie', this.service.cookie(token)); return state;
  }
  @Post('session/logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const state = await this.service.logout(this.token(req, res)); res.setHeader('Set-Cookie', [this.service.cookie('', true), this.legacyCookie()]); return state;
  }
  @Post(['selection', 'participant/selection']) select(@Body() dto: ParticipantSelectionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.select(this.token(req, res), dto); }
  @Post(['campaign', 'participant/campaign']) campaign(@Body() dto: ParticipantCampaignDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.changeCampaign(this.token(req, res), dto.campaignId); }
  @Post(['orders', 'participant/orders']) confirm(@Body() dto: ParticipantOrderDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.confirm(this.token(req, res), dto.idempotencyKey); }
  @Get(['tickets', 'participant/tickets']) tickets(@Query() dto: ParticipantTicketQueryDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.tickets(this.token(req, res), dto.page, dto.query, dto.selectedOnly === 'true'); }
  @Get(['results', 'participant/results']) results(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.results(this.token(req, res)); }
}
