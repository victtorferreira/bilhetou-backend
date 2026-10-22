import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { ParticipantCampaignDto, ParticipantOrderDto, ParticipantSelectionDto, ParticipantTicketQueryDto, RegisterParticipantDto } from './participant.dto';
import { demoOrigins } from '../tickets/local-demo.guard';

interface Request { method: string; headers: Record<string, string | undefined> }
interface Response { setHeader(name: string, value: string): void }
@Injectable()
export class ParticipantOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.origin && !demoOrigins().includes(request.headers.origin)) throw new ForbiddenException('Origem não permitida.');
    if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) throw new ForbiddenException('Envie JSON.');
    return true;
  }
}
@Controller('demo')
@UseGuards(ParticipantOriginGuard)
export class ParticipantController {
  constructor(private readonly service: ParticipantService) {}
  private token(req: Request, res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.service.token(req.headers.cookie); }
  @Get('session') current(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.current(this.token(req, res)); }
  @Post('session') async register(@Body() dto: RegisterParticipantDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, state } = await this.service.register(dto.name, dto.phone, this.token(req, res));
    res.setHeader('Set-Cookie', this.service.cookie(token)); return state;
  }
  @Post('session/logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const state = await this.service.logout(this.token(req, res)); res.setHeader('Set-Cookie', this.service.cookie('', true)); return state;
  }
  @Post('participant/selection') select(@Body() dto: ParticipantSelectionDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.select(this.token(req, res), dto); }
  @Post('participant/campaign') campaign(@Body() dto: ParticipantCampaignDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.changeCampaign(this.token(req, res), dto.campaignId); }
  @Post('participant/orders') confirm(@Body() dto: ParticipantOrderDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.confirm(this.token(req, res), dto.idempotencyKey); }
  @Get('participant/tickets') tickets(@Query() dto: ParticipantTicketQueryDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.tickets(this.token(req, res), dto.page, dto.query, dto.selectedOnly === 'true'); }
  @Get('participant/results') results(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.service.results(this.token(req, res)); }
}
