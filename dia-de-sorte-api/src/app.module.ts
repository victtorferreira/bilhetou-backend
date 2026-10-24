import { AdminAuth, AdminSessionStore } from './tickets/admin-auth';
import { ParticipantController, ParticipantOriginGuard } from './participants/participant.controller';
import { ParticipantService } from './participants/participant.service';
import { WhatsappWelcomeService } from './participants/whatsapp-welcome.service';
import { HealthController } from './health.controller';
import { AbacatepaySandboxController } from './payments/abacatepay-sandbox.controller';
import { AbacatepaySandboxService } from './payments/abacatepay-sandbox.service';
import { PixPaymentController, PixPaymentWebhookController } from './payments/pix-payment.controller';
import { PixPaymentService } from './payments/pix-payment.service';
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
@Module({ imports: [PrismaModule], controllers: [PixPaymentController, PixPaymentWebhookController, AbacatepaySandboxController, HealthController, AdminParticipantsController, ParticipantController, AdminSessionController, AdminTicketsController, CampaignsController, TicketsController, DrawsController], providers: [PixPaymentService, AbacatepaySandboxService, WhatsappWelcomeService, AdminParticipantsService, ParticipantService, ParticipantOriginGuard, AdminSessionStore, AdminAuth, AdminTicketService, TicketCreationService] })
export class AppModule {}
