import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('tickets')
export class TicketsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id }, select: { id: true, serial: true, status: true, campaignId: true, numbers: { select: { position: true, value: true }, orderBy: { position: 'asc' } } } });
    if (!ticket) throw new NotFoundException('Bilhete não encontrado');
    return ticket;
  }
}
