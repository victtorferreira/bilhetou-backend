import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminParticipantQueryDto } from './admin-participants.dto';

const pageSize = 20;
const maskedPhone = (phone: string) => `(${phone.slice(0, 2)}) 9****-${phone.slice(-4)}`;
const pagination = (total: number, requested: number) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, totalPages);
  return { total, page, totalPages, skip: (page - 1) * pageSize };
};

@Injectable()
export class AdminParticipantsService {
  constructor(private readonly prisma: PrismaService) {}
  private orderScope(organizationId: string, campaignId?: string): Prisma.OrderWhereInput {
    return { legacySample: false, campaign: { organizationId, legacySample: false, ...(campaignId ? { id: campaignId } : {}) } };
  }
  private async participant(tx: Prisma.TransactionClient, organizationId: string, id: string) {
    const participant = await tx.participant.findFirst({ where: { id, organizationId }, select: { id: true, name: true, phone: true, createdAt: true } });
    if (!participant) throw new NotFoundException('Participante não encontrado.');
    return participant;
  }
  async list(organizationId: string, input: AdminParticipantQueryDto) {
    return this.prisma.$transaction(async tx => {
      if (input.campaignId && !await tx.campaign.findFirst({ where: { id: input.campaignId, organizationId, legacySample: false }, select: { id: true } })) throw new NotFoundException('Campanha não encontrada.');
      const scope = this.orderScope(organizationId, input.campaignId);
      const query = input.query.trim().replace(/\s+/g, ' ');
      let digits = query.replace(/\D/g, '');
      if (digits.length === 13 && digits.startsWith('55')) digits = digits.slice(2);
      const filters: Prisma.ParticipantWhereInput[] = [];
      if (query) filters.push({ OR: [{ name: { contains: query, mode: 'insensitive' } }, ...(digits ? [{ phone: { contains: digits } }] : [])] });
      if (input.activity === 'without_orders') {
        // With a campaign selected, include people without orders in that campaign.
        filters.push({ orders: { none: scope } });
      } else if (input.campaignId || input.activity === 'with_orders') filters.push({ orders: { some: scope } });
      const where: Prisma.ParticipantWhereInput = { organizationId, AND: filters };
      const total = await tx.participant.count({ where });
      const { skip, ...paging } = pagination(total, input.page);
      const participants = await tx.participant.findMany({ where, select: { id: true, name: true, phone: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: pageSize });
      const ids = participants.map(p => p.id);
      const counts = ids.length ? await tx.order.groupBy({ by: ['participantId'], where: { ...scope, participantId: { in: ids } }, _count: { _all: true }, _sum: { quantity: true } }) : [];
      const byParticipant = new Map(counts.map(row => [row.participantId, row]));
      const totals = await tx.order.aggregate({ where: { ...scope, participant: where }, _count: { _all: true }, _sum: { quantity: true } });
      return {
        ...paging,
        summary: { participants: total, orders: totals._count._all, tickets: totals._sum.quantity ?? 0 },
        items: participants.map(({ phone, ...p }) => ({ ...p, phoneMasked: maskedPhone(phone), orders: byParticipant.get(p.id)?._count._all ?? 0, tickets: byParticipant.get(p.id)?._sum.quantity ?? 0 })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async detail(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      const participant = await this.participant(tx, organizationId, id);
      const where = { ...this.orderScope(organizationId), participantId: id };
      const totals = await tx.order.aggregate({ where, _count: { _all: true }, _sum: { totalCents: true, quantity: true } });
      return { ...participant, phoneMasked: maskedPhone(participant.phone), verification: 'unverified', summary: { orders: totals._count._all, tickets: totals._sum.quantity ?? 0, orderValueCents: totals._sum.totalCents ?? 0 } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async orders(organizationId: string, id: string, requestedPage: number) {
    return this.prisma.$transaction(async tx => {
      await this.participant(tx, organizationId, id);
      const where = { ...this.orderScope(organizationId), participantId: id };
      const total = await tx.order.count({ where });
      const { skip, ...paging } = pagination(total, requestedPage);
      const orders = await tx.order.findMany({ where, select: { id: true, createdAt: true, quantity: true, totalCents: true, paymentStatus: true, campaign: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: pageSize });
      return { ...paging, items: orders.map(order => ({ ...order, status: 'REGISTERED', paymentStatus: order.paymentStatus || 'UNPAID' })) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async tickets(organizationId: string, id: string, requestedPage: number) {
    return this.prisma.$transaction(async tx => {
      await this.participant(tx, organizationId, id);
      const where: Prisma.TicketWhereInput = { campaign: { organizationId, legacySample: false }, order: { ...this.orderScope(organizationId), participantId: id } };
      const total = await tx.ticket.count({ where });
      const { skip, ...paging } = pagination(total, requestedPage);
      const items = await tx.ticket.findMany({ where, select: { id: true, serial: true, status: true, assignedAt: true, orderId: true, campaign: { select: { id: true, name: true } }, numbers: { select: { value: true, position: true }, orderBy: { position: 'asc' } } }, orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }], skip, take: pageSize });
      return { ...paging, items };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
