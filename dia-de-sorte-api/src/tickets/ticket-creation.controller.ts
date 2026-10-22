import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { LocalDemoGuard } from './local-demo.guard';
import { ConfirmTicketsDto, PreviewTicketsDto, TicketStockQueryDto } from './ticket-creation.dto';
import { TicketCreationService } from './ticket-creation.service';

@Controller('demo/ticket-batches')
@UseGuards(LocalDemoGuard)
export class TicketCreationController {
  constructor(private readonly service: TicketCreationService) {}
  @Get('campaigns') listCampaigns() { return this.service.listCampaigns(); }
  @Get('campaigns/:campaignId/tickets') stock(@Param('campaignId', ParseUUIDPipe) campaignId: string, @Query() query: TicketStockQueryDto) { return this.service.listTickets(campaignId, query.page, query.query); }
  @Post('preview') preview(@Body() dto: PreviewTicketsDto) { return this.service.preview(dto.campaignId, dto); }
  @Post('confirm') confirm(@Body() dto: ConfirmTicketsDto) { return this.service.confirm(dto.token); }
}
