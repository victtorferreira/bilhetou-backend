import { AdminAuth } from './tickets/admin-auth';
import { AdminTicketService } from './tickets/admin-ticket.service';
import { AdminSessionController, AdminTicketsController } from './tickets/admin.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CampaignsController } from './campaigns/campaigns.controller';
import { TicketsController } from './tickets/tickets.controller';
import { DemoController } from './demo/demo.controller';
import { DrawsController } from './draws/draws.controller';
import { DemoService } from './demo/demo.service';
import { TicketCreationController } from './tickets/ticket-creation.controller';
import { TicketCreationService } from './tickets/ticket-creation.service';
import { LocalDemoGuard } from './tickets/local-demo.guard';
@Module({ imports: [PrismaModule], controllers: [AdminSessionController, AdminTicketsController, CampaignsController, TicketsController, DemoController, DrawsController, TicketCreationController], providers: [AdminAuth, AdminTicketService, DemoService, TicketCreationService, LocalDemoGuard] })
export class AppModule {}
