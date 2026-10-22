import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuth, type AdminRequest } from '../tickets/admin-auth';
import { AdminParticipantPageDto, AdminParticipantQueryDto } from './admin-participants.dto';
import { AdminParticipantsService } from './admin-participants.service';

@Controller('admin/participants')
@UseGuards(AdminAuth)
export class AdminParticipantsController {
  constructor(private readonly service: AdminParticipantsService) {}
  @Get() list(@Req() req: AdminRequest, @Query() query: AdminParticipantQueryDto) { return this.service.list(req.admin.organizationId, query); }
  @Get(':id') detail(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.detail(req.admin.organizationId, id); }
  @Get(':id/orders') orders(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Query() query: AdminParticipantPageDto) { return this.service.orders(req.admin.organizationId, id, query.page); }
  @Get(':id/tickets') tickets(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Query() query: AdminParticipantPageDto) { return this.service.tickets(req.admin.organizationId, id, query.page); }
}
