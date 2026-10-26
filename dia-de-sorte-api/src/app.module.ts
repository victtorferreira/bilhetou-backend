import { AdminAuth, AdminSessionStore } from './tickets/admin-auth';
import { ParticipantController, ParticipantOriginGuard } from './participants/participant.controller';
import { ParticipantService } from './participants/participant.service';
import { WhatsappWelcomeService } from './participants/whatsapp-welcome.service';
import { HealthController } from './health.controller';
import { ZettpayCheckoutController, ZettpayWebhookController } from './payments/zettpay.controller';
import { ZettpayService } from './payments/zettpay.service';
import { ZettpayClient } from './payments/zettpay.client';
import { AdminParticipantsController } from './participants/admin-participants.controller';
import { AdminParticipantsService } from './participants/admin-participants.service';
import { AdminTicketService } from './tickets/admin-ticket.service';
import { AdminSessionController, AdminTicketsController } from './tickets/admin.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CampaignsController } from './campaigns/campaigns.controller';
import { TicketsController } from './tickets/tickets.controller';
import { DrawsController } from './draws/draws.controller';
import { TicketCreationService } from './tickets/ticket-creation.service';
import { APP_GUARD } from '@nestjs/core';
import { RequestLimits } from './security/request-limits';
import { ReservationCleanup } from './payments/reservations';
@Module({ imports: [PrismaModule], controllers: [ZettpayCheckoutController, ZettpayWebhookController, HealthController, AdminParticipantsController, ParticipantController, AdminSessionController, AdminTicketsController, CampaignsController, TicketsController, DrawsController], providers: [{ provide: APP_GUARD, useClass: RequestLimits }, ReservationCleanup, ZettpayService, ZettpayClient, WhatsappWelcomeService, AdminParticipantsService, ParticipantService, ParticipantOriginGuard, AdminSessionStore, AdminAuth, AdminTicketService, TicketCreationService] })
export class AppModule {}
