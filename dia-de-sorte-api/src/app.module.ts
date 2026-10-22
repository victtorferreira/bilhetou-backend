import { AdminAuth, AdminSessionStore } from './tickets/admin-auth';
import { ParticipantController, ParticipantOriginGuard } from './participants/participant.controller';
import { ParticipantService } from './participants/participant.service';
import { AdminTicketService } from './tickets/admin-ticket.service';
import { AdminSessionController, AdminTicketsController } from './tickets/admin.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CampaignsController } from './campaigns/campaigns.controller';
import { TicketsController } from './tickets/tickets.controller';
import { DrawsController } from './draws/draws.controller';
import { TicketCreationService } from './tickets/ticket-creation.service';
@Module({ imports: [PrismaModule], controllers: [ParticipantController, AdminSessionController, AdminTicketsController, CampaignsController, TicketsController, DrawsController], providers: [ParticipantService, ParticipantOriginGuard, AdminSessionStore, AdminAuth, AdminTicketService, TicketCreationService] })
export class AppModule {}
