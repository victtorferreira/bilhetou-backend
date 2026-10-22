import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('draws')
export class DrawsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get(':campaignId')
  list(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.prisma.draw.findMany({ where: { campaignId }, include: { results: { orderBy: { position: 'asc' } }, _count: { select: { matches: true } } }, orderBy: { createdAt: 'desc' } });
  }
}
