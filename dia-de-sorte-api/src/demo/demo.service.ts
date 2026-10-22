import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
@Injectable()
export class DemoService {
  constructor(private readonly prisma: PrismaService) {}
  async create(campaignId: string, quantity: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId}::uuid FOR UPDATE`;
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) throw new NotFoundException('Campanha não encontrada');
      if (campaign.status !== 'OPEN' || (campaign.closesAt && campaign.closesAt <= new Date())) {
        throw new ConflictException('Campanha não está aberta');
      }
      // SKIP LOCKED garante que requisições concorrentes não atribuam o mesmo estoque.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Ticket"
        WHERE "campaignId" = ${campaignId}::uuid AND status = 'AVAILABLE'::"TicketStatus"
        ORDER BY "createdAt", id
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length !== quantity) throw new ConflictException('Estoque demonstrativo insuficiente');
      const order = await tx.demoOrder.create({ data: { campaignId, quantity, totalCents: quantity * campaign.ticketPriceCents } });
      const ids = rows.map(r => r.id);
      await tx.ticket.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'ASSIGNED_DEMO', demoOrderId: order.id, assignedAt: new Date() } });
      const tickets = await tx.ticket.findMany({ where: { id: { in: ids } }, select: { id: true, serial: true, numbers: { select: { position: true, value: true }, orderBy: { position: 'asc' } } } });
      return { demoOnly: true, paymentCollected: false, orderId: order.id, totalCents: order.totalCents, tickets };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
