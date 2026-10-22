import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  list() {
    return this.prisma.campaign.findMany({
      select: { id: true, name: true, status: true, rulesVersion: true, ticketPriceCents: true, closesAt: true, _count: { select: { tickets: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
