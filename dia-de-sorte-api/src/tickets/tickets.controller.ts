import { Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
@Controller('tickets')
export class TicketsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get(':id/verification')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async verify(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID;
    if (!organizationId) throw new NotFoundException('Bilhete não encontrado');
    // The random UUID is a public reference, never proof of ownership. Select no buyer data.
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, campaign: { organizationId, legacySample: false, deletedAt: null, status: { not: 'DRAFT' } } },
      select: {
        serial: true, status: true, assignedAt: true,
        numbers: { select: { value: true }, orderBy: { position: 'asc' } },
        campaign: { select: { name: true, closesAt: true } },
        order: { select: { legacySample: true, paymentStatus: true, paymentRequired: true, totalCents: true, reservationExpiresAt: true } },
      },
    });
    if (!ticket || ticket.order?.legacySample) throw new NotFoundException('Bilhete não encontrado');
    const order = ticket.order;
    const paid = order?.paymentStatus === 'PAID';
    const free = !!order && !order.paymentRequired && order.totalCents === 0;
    // Do not rely on the periodic cleanup having already released an expired reservation.
    const expired = order?.paymentStatus === 'EXPIRED' || (order?.paymentStatus === 'UNPAID' && !!order.reservationExpiresAt && order.reservationExpiresAt <= new Date());
    const status = ticket.status === 'VOID' ? 'VOID'
      : ticket.status !== 'ASSIGNED' || !order ? 'NOT_ISSUED'
      : expired ? 'EXPIRED'
      : order.paymentStatus === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED'
      : paid || free ? 'VALID' : 'PENDING_PAYMENT';
    return {
      serial: ticket.serial, numbers: ticket.numbers.map(number => number.value),
      campaignName: ticket.campaign.name, drawAt: ticket.campaign.closesAt?.toISOString() ?? null,
      issuedAt: ticket.assignedAt?.toISOString() ?? null, status,
      paymentStatus: paid ? 'PAID' : free ? 'NOT_REQUIRED' : 'NOT_CONFIRMED',
      checkedAt: new Date().toISOString(),
    };
  }
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID;
    if (!organizationId) throw new NotFoundException('Bilhete não encontrado');
    const ticket = await this.prisma.ticket.findFirst({ where: { id, status: 'AVAILABLE', campaign: { organizationId, legacySample: false, deletedAt: null, status: 'OPEN', OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] } }, select: { id: true, serial: true, status: true, campaignId: true, numbers: { select: { position: true, value: true }, orderBy: { position: 'asc' } } } });
    if (!ticket) throw new NotFoundException('Bilhete não encontrado');
    return ticket;
  }
}
