import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminParticipantQueryDto } from './admin-participants.dto';

const pageSize = 20;
type GroupedParticipant = { id: string; name: string; phone: string; createdAt: Date; registrations: number; orders: number; tickets: number };
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
  private async participantGroup(tx: Prisma.TransactionClient, organizationId: string, id: string) {
    const participant = await this.participant(tx, organizationId, id);
    // Group only for the authenticated admin. Public sessions keep their own identity.
    const members = await tx.$queryRaw<{ id: string; createdAt: Date }[]>(Prisma.sql`
      SELECT id, "createdAt" FROM "Participant"
      WHERE "organizationId" = ${organizationId}::uuid AND phone = ${participant.phone}
        AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(${participant.name}), '\\s+', ' ', 'g'))
      ORDER BY "createdAt" ASC, id ASC
    `);
    return { participant: { ...participant, createdAt: members[0].createdAt }, ids: members.map(member => member.id), registrations: members.length };
  }
  async list(organizationId: string, input: AdminParticipantQueryDto) {
    return this.prisma.$transaction(async tx => {
      const mode = input.campaignId ? 'campaign' : input.campaignScope === 'all' ? 'all' : 'current';
      const campaignWhere = { organizationId, legacySample: false };
      const select = { id: true, name: true, status: true, closesAt: true } as const;
      const now = new Date();
      let campaign = mode === 'campaign'
        ? await tx.campaign.findFirst({ where: { ...campaignWhere, id: input.campaignId }, select })
        : mode === 'current'
          ? await tx.campaign.findFirst({ where: { ...campaignWhere, deletedAt: null, status: 'OPEN', OR: [{ closesAt: null }, { closesAt: { gt: now } }] }, select, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })
          : null;
      if (mode === 'campaign' && !campaign) throw new NotFoundException('Campanha não encontrada.');
      const active = !!campaign && campaign.status === 'OPEN' && (!campaign.closesAt || campaign.closesAt > now);
      if (mode === 'current' && !campaign) {
        campaign = await tx.campaign.findFirst({ where: { ...campaignWhere, deletedAt: null, status: { not: 'DRAFT' } }, select, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      }
      const query = input.query.trim().replace(/\s+/g, ' ');
      let digits = query.replace(/\D/g, '');
      if (digits.length === 13 && digits.startsWith('55')) digits = digits.slice(2);
      const campaignFilter = mode === 'all' ? Prisma.empty : campaign ? Prisma.sql`AND c.id = ${campaign.id}::uuid` : Prisma.sql`AND FALSE`;
      const search = query ? Prisma.sql`AND (strpos(lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g')), lower(${query})) > 0 ${digits ? Prisma.sql`OR strpos(p.phone, ${digits}) > 0` : Prisma.empty})` : Prisma.empty;
      // Filter activity after grouping: a second registration without purchases
      // must not make a group with purchases appear under "Sem pedidos".
      const activity = input.activity === 'with_orders' ? Prisma.sql`WHERE orders > 0` : input.activity === 'without_orders' ? Prisma.sql`WHERE orders = 0` : Prisma.empty;
      const groups = Prisma.sql`
        WITH activity AS (
          SELECT o."participantId", count(*)::int AS orders, sum(o.quantity)::int AS tickets
          FROM "Order" o JOIN "Campaign" c ON c.id = o."campaignId"
          WHERE NOT o."legacySample" AND NOT c."legacySample" AND c."organizationId" = ${organizationId}::uuid ${campaignFilter}
          GROUP BY o."participantId"
        ), grouped AS (
          SELECT (array_agg(p.id ORDER BY p."createdAt", p.id))[1] AS id,
            (array_agg(p.name ORDER BY p."createdAt", p.id))[1] AS name,
            p.phone, min(p."createdAt") AS "createdAt", max(p."createdAt") AS "lastRegisteredAt",
            count(*)::int AS registrations, sum(coalesce(a.orders, 0))::int AS orders, sum(coalesce(a.tickets, 0))::int AS tickets
          FROM "Participant" p LEFT JOIN activity a ON a."participantId" = p.id
          WHERE p."organizationId" = ${organizationId}::uuid ${search}
          GROUP BY p.phone, lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g'))
        ), filtered AS (SELECT * FROM grouped ${activity})
      `;
      const [totals] = await tx.$queryRaw<{ participants: number; orders: number; tickets: number }[]>(Prisma.sql`
        ${groups} SELECT count(*)::int AS participants, coalesce(sum(orders), 0)::int AS orders, coalesce(sum(tickets), 0)::int AS tickets FROM filtered
      `);
      const { skip, ...paging } = pagination(totals.participants, input.page);
      const participants = await tx.$queryRaw<GroupedParticipant[]>(Prisma.sql`
        ${groups} SELECT id, name, phone, "createdAt", registrations, orders, tickets FROM filtered
        ORDER BY "lastRegisteredAt" DESC, id ASC LIMIT ${pageSize} OFFSET ${skip}
      `);
      return {
        ...paging,
        campaignScope: { mode, active, campaign: campaign ? { id: campaign.id, name: campaign.name } : null },
        summary: totals,
        items: participants.map(({ phone, ...p }) => ({ ...p, phoneMasked: maskedPhone(phone) })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async detail(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      const { participant, ids, registrations } = await this.participantGroup(tx, organizationId, id);
      const where = { ...this.orderScope(organizationId), participantId: { in: ids } };
      const totals = await tx.order.aggregate({ where, _count: { _all: true }, _sum: { totalCents: true, quantity: true } });
      return { ...participant, registrations, phoneMasked: maskedPhone(participant.phone), verification: 'unverified', summary: { orders: totals._count._all, tickets: totals._sum.quantity ?? 0, orderValueCents: totals._sum.totalCents ?? 0 } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async orders(organizationId: string, id: string, requestedPage: number) {
    return this.prisma.$transaction(async tx => {
      const { ids } = await this.participantGroup(tx, organizationId, id);
      const where = { ...this.orderScope(organizationId), participantId: { in: ids } };
      const total = await tx.order.count({ where });
      const { skip, ...paging } = pagination(total, requestedPage);
      const orders = await tx.order.findMany({ where, select: { id: true, createdAt: true, quantity: true, totalCents: true, paymentStatus: true, campaign: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: pageSize });
      return { ...paging, items: orders.map(order => ({ ...order, status: 'REGISTERED', paymentStatus: order.paymentStatus || 'UNPAID' })) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async tickets(organizationId: string, id: string, requestedPage: number) {
    return this.prisma.$transaction(async tx => {
      const { ids } = await this.participantGroup(tx, organizationId, id);
      const where: Prisma.TicketWhereInput = { campaign: { organizationId, legacySample: false }, order: { ...this.orderScope(organizationId), participantId: { in: ids } } };
      const total = await tx.ticket.count({ where });
      const { skip, ...paging } = pagination(total, requestedPage);
      const items = await tx.ticket.findMany({ where, select: { id: true, serial: true, status: true, assignedAt: true, orderId: true, campaign: { select: { id: true, name: true } }, numbers: { select: { value: true, position: true }, orderBy: { position: 'asc' } } }, orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }], skip, take: pageSize });
      return { ...paging, items };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
