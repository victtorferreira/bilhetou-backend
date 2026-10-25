import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AdminAuth, type AdminRequest } from './admin-auth';
import { AdminTicketService } from './admin-ticket.service';
import { AdminLoginDto, CheckDrawDto, CreateCampaignDto, ImportTicketsDto, NumberSearchDto } from './admin.dto';
import { ConfirmTicketsDto, PreviewTicketsDto, TicketStockQueryDto } from './ticket-creation.dto';
import { TicketCreationService } from './ticket-creation.service';
import { allowedOrigins } from '../security/origins';

@Controller('admin/session')
export class AdminSessionController {
  constructor(private readonly auth: AdminAuth) {}
  @Post()
  login(@Body() dto: AdminLoginDto, @Req() req: AdminRequest & { socket: { remoteAddress?: string } }, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }) {
    if (req.headers.origin && !allowedOrigins().includes(req.headers.origin)) throw new ForbiddenException();
    const token = this.auth.login(dto.secret, req.socket.remoteAddress || 'unknown');
    res.setHeader('Set-Cookie', this.auth.cookie(token));
    res.setHeader('Cache-Control', 'no-store');
    return { authenticated: true };
  }
  @Get() @UseGuards(AdminAuth) session(@Req() req: AdminRequest) { return req.admin; }
  @Post('logout') @UseGuards(AdminAuth)
  logout(@Req() req: AdminRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }) {
    this.auth.logout(req); res.setHeader('Set-Cookie', this.auth.cookie('', true)); return { authenticated: false };
  }
}
@Controller('admin')
@UseGuards(AdminAuth)
export class AdminTicketsController {
  constructor(private readonly service: AdminTicketService, private readonly creation: TicketCreationService) {}
  @Get('campaigns') campaigns(@Req() req: AdminRequest) { return this.service.campaigns(req.admin.organizationId); }
  @Delete('campaigns/:id') deleteCampaign(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.deleteCampaign(req.admin.organizationId, id); }
  @Post('campaigns') createCampaign(@Req() req: AdminRequest, @Body() dto: CreateCampaignDto) { return this.service.createCampaign(req.admin.organizationId, dto); }
  @Get('campaigns/:id/ticket-statistics') stats(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.statistics(req.admin.organizationId, id); }
  @Get('campaigns/:id/tickets') stock(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Query() q: TicketStockQueryDto) { return this.service.stock(req.admin.organizationId, id, q.page, q.query); }
  @Get('campaigns/:id/tickets/search') search(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Query() q: NumberSearchDto) { return this.service.search(req.admin.organizationId, id, q.number); }
  @Post('campaigns/:id/tickets/import') import(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportTicketsDto) { return this.service.import(req.admin.organizationId, id, dto.rows); }
  @Get('campaigns/:id/draws/check') history(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.history(req.admin.organizationId, id); }
  @Post('campaigns/:id/draws/check') check(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckDrawDto) { return this.service.check(req.admin.organizationId, id, dto.reference, dto.number, req.admin.actor); }
  @Post('ticket-batches/preview') async preview(@Req() req: AdminRequest, @Body() dto: PreviewTicketsDto) { await this.service.campaign(req.admin.organizationId, dto.campaignId); return this.creation.preview(dto.campaignId, dto, req.admin.organizationId); }
  @Post('ticket-batches/confirm') confirm(@Req() req: AdminRequest, @Body() dto: ConfirmTicketsDto) { return this.creation.confirm(dto.token, req.admin.organizationId); }
  @Get('dashboard') async dashboard(@Req() req: AdminRequest) {
    return this.service.dashboard(req.admin.organizationId);
  }
}
