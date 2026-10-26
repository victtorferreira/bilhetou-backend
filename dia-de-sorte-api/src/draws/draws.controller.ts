import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('draws')
export class DrawsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get(':campaignId')
  list(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    const organizationId = process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID;
    if (!organizationId) return [];
    return this.prisma.draw.findMany({ where: { campaignId, status: { in: ['RECORDED', 'REVIEWED'] }, campaign: { organizationId, legacySample: false, deletedAt: null, status: { in: ['CLOSED', 'ARCHIVED'] } } }, select: { id: true, campaignId: true, reference: true, createdAt: true, results: { select: { number: true, position: true }, orderBy: { position: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
