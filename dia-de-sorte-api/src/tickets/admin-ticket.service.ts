import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { validateImport, type ImportRow } from './ticket-import';
import type { CreateCampaignDto } from './admin.dto';

export function ticketConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004', 'P2034'].includes(error.code)) throw new ConflictException('O estoque mudou: número ou serial já utilizado. Atualize e tente novamente.');
  throw error;
}
@Injectable()
export class AdminTicketService {
  constructor(private readonly prisma: PrismaService) {}
  async campaign(organizationId: string, id: string, tx: Prisma.TransactionClient = this.prisma) {
    const campaign = await tx.campaign.findFirst({ where: { id, organizationId, legacySample: false, deletedAt: null } });
    if (!campaign) throw new NotFoundException('Campanha não encontrada.');
    return campaign;
  }
  campaigns(organizationId: string) {
    return this.prisma.campaign.findMany({ where: { organizationId, legacySample: false, deletedAt: null }, include: { _count: { select: { tickets: true } } }, orderBy: { createdAt: 'desc' } });
  }
  async deleteCampaign(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${id}::uuid AND "organizationId" = ${organizationId}::uuid FOR UPDATE`;
      await this.campaign(organizationId, id, tx);
      // Preserve orders, payments, tickets and draw observations as historical records.
      await tx.campaign.update({ where: { id }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
      return { id, deleted: true };
    });
  }
  async createCampaign(organizationId: string, input: CreateCampaignDto) {
    if (input.name.trim().length < 3) throw new ConflictException('Informe um nome válido para a campanha.');
    if (input.closesAt && new Date(input.closesAt) <= new Date()) throw new ConflictException('A data de encerramento deve estar no futuro.');
    if (!await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) throw new NotFoundException('Organização não cadastrada.');
    return this.prisma.campaign.create({ data: { organizationId, name: input.name.trim(), ticketPriceCents: input.ticketPriceCents, prizeCents: input.prizeCents, status: input.status, closesAt: input.closesAt ? new Date(input.closesAt) : null, rulesVersion: 'v1' } });
  }
  async dashboard(organizationId: string) {
    return this.prisma.$transaction(async tx => {
      const campaign = { organizationId, legacySample: false, deletedAt: null };
      const [tickets, available, assigned, campaigns, orders, participants] = await Promise.all([
        tx.ticket.count({ where: { campaign } }),
        tx.ticket.count({ where: { campaign, status: 'AVAILABLE' } }),
        tx.ticket.count({ where: { campaign, status: 'ASSIGNED' } }),
        tx.campaign.count({ where: campaign }),
        tx.order.count({ where: { campaign, legacySample: false } }),
        tx.participant.count({ where: { organizationId } }),
      ]);
      return { tickets, available, assigned, campaigns, orders, participants };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async statistics(org: string, id: string) {
    await this.campaign(org, id);
    return this.prisma.$transaction(async tx => {
      const used = await tx.ticketNumber.count({ where: { campaignId: id } });
      const tickets = await tx.ticket.count({ where: { campaignId: id } });
      return { possible: 10000, used, available: 10000 - used, tickets, remainingTickets: Math.min(2500 - tickets, Math.floor((10000 - used) / 4)) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async stock(org: string, id: string, page: number, query: string) {
    const campaign = await this.campaign(org, id);
    const where: Prisma.TicketWhereInput = { campaignId: id, ...(/^[0-9]{4}$/.test(query) ? { numbers: { some: { value: query } } } : { serial: { contains: query.trim(), mode: 'insensitive' } }) };
    return this.prisma.$transaction(async tx => {
      const total = await tx.ticket.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / 20));
      const current = Math.min(page, totalPages);
      const items = await tx.ticket.findMany({ where, skip: (current - 1) * 20, take: 20, include: { numbers: { orderBy: { position: 'asc' } }, order: { select: { participant: { select: { name: true } } } } }, orderBy: [{ createdAt: 'desc' }, { serial: 'asc' }] });
      return { items: items.map(({ order, ...t }) => ({ ...t, campaign: campaign.name, participant: order?.participant?.name ?? null })), total, page: current, totalPages };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async search(org: string, id: string, number: string) {
    await this.campaign(org, id);
    const match = await this.prisma.ticketNumber.findUnique({ where: { campaignId_value: { campaignId: id, value: number } }, include: { ticket: { include: { numbers: { orderBy: { position: 'asc' } } } } } });
    return { number, ticket: match?.ticket ?? null, message: match ? 'Correspondência encontrada.' : 'Número não encontrado nos bilhetes desta campanha.' };
  }
  async import(org: string, id: string, rows: ImportRow[]) {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${id}::uuid FOR UPDATE`;
        const campaign = await this.campaign(org, id, tx);
        if (!['DRAFT', 'OPEN'].includes(campaign.status) || (campaign.closesAt && campaign.closesAt <= new Date())) throw new ConflictException('Campanha encerrada.');
        const stock = await tx.ticket.findMany({ where: { campaignId: id }, select: { serial: true, numbers: { select: { value: true } } } });
        const report = validateImport(rows, stock);
        const tickets = report.valid.map(row => ({ id: randomUUID(), campaignId: id, serial: row.serial }));
        if (tickets.length) {
          await tx.ticket.createMany({ data: tickets });
          await tx.ticketNumber.createMany({ data: report.valid.flatMap((row, i) => row.numbers.map((value, position) => ({ ticketId: tickets[i].id, campaignId: id, value, position: position + 1 }))) });
        }
        return { total: report.total, valid: report.valid.length, created: tickets.length, rejected: report.rejected, duplicateNumbers: report.duplicateNumbers, errors: report.errors };
      }, { timeout: 30000 });
    } catch (error) { ticketConflict(error); }
  }
  async history(org: string, id: string) {
    await this.campaign(org, id);
    return this.prisma.drawCheck.findMany({ where: { campaignId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  async check(org: string, id: string, reference: string, number: string, actor: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${id}::uuid FOR UPDATE`;
      const campaign = await this.campaign(org, id, tx);
      const previous = await tx.drawCheck.findUnique({ where: { campaignId_reference: { campaignId: id, reference } } });
      if (previous) {
        if (previous.number !== number) throw new ConflictException('Esta referência já foi conferida com outro número. O histórico foi preservado.');
        return previous;
      }
      if (!['CLOSED', 'ARCHIVED'].includes(campaign.status) || !campaign.closesAt || campaign.closesAt > new Date()) throw new ConflictException('Encerre a campanha e registre closesAt antes da conferência.');
      const match = await tx.ticketNumber.findUnique({ where: { campaignId_value: { campaignId: id, value: number } }, include: { ticket: true } });
      const ticket = match?.ticket;
      // Assignment is not evidence of a confirmed payment.
      const assignedBeforeClose = !!(ticket?.assignedAt && ticket.assignedAt <= campaign.closesAt);
      const snapshot = {
        ticketId: ticket?.id ?? null, serial: ticket?.serial ?? null, status: ticket?.status ?? null,
        closesAt: campaign.closesAt.toISOString(), assignedAt: ticket?.assignedAt?.toISOString() ?? null,
        assignedBeforeClose, sold: false, eligible: false, participant: null,
        historicalStatus: ticket?.status === 'VOID' ? 'UNKNOWN' : assignedBeforeClose ? 'ASSIGNED' : ticket ? 'AVAILABLE' : null,
        message: !ticket ? 'Número não encontrado nos bilhetes desta campanha.' : 'Número encontrado, mas o bilhete não foi vendido.',
        note: 'Atribuição não comprova pagamento. A conferência não autoriza prêmio. Cancelamentos não possuem histórico temporal.',
      };
      return tx.drawCheck.create({ data: { campaignId: id, reference, number, actor, snapshot } });
    });
  }
}
