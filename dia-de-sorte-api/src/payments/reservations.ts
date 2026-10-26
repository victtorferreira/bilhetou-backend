import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';

export const reservationLifetime = 15 * 60_000;
export const maxReservationTickets = 100;

// Caller holds the campaign lock. Payment reconciliation uses that same lock.
export async function expireReservations(tx: Prisma.TransactionClient, campaignId: string, now = new Date()) {
  const order = { campaignId, paymentStatus: 'UNPAID', paymentRequired: true, reservationExpiresAt: { lte: now } };
  await tx.ticket.updateMany({ where: { campaignId, status: 'ASSIGNED', order }, data: { status: 'AVAILABLE', orderId: null, assignedAt: null } });
  await tx.order.updateMany({ where: order, data: { paymentStatus: 'EXPIRED' } });
}

@Injectable()
export class ReservationCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationCleanup.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.sweep().catch(() => this.logger.error('Falha ao expirar reservas.')).finally(() => { this.running = undefined; });
    }, 30_000);
    this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }
  async sweep() {
    const orders = await this.prisma.order.findMany({ where: { paymentRequired: true, paymentStatus: 'UNPAID', reservationExpiresAt: { lte: new Date() } }, select: { campaignId: true }, distinct: ['campaignId'], take: 100 });
    for (const { campaignId } of orders) await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId}::uuid FOR UPDATE`;
      await expireReservations(tx, campaignId);
    });
    await this.prisma.requestLimit.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3_600_000) } } });
  }
}
