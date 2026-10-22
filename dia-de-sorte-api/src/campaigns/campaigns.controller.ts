import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  list() {
    return this.prisma.campaign.findMany({
      where: { organizationId: process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID || '00000000-0000-0000-0000-000000000000', legacySample: false, status: 'OPEN' },
      select: { id: true, name: true, status: true, rulesVersion: true, ticketPriceCents: true, prizeCents: true, closesAt: true, _count: { select: { tickets: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
