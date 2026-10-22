import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ticketConflict } from './admin-ticket.service';
import { Prisma } from '../generated/prisma/client';
import { generateTickets, type GeneratedTicket, type GenerationInput } from './ticket-generator';

interface PreviewPayload {
  version: 1;
  batchId: string;
  campaignId: string;
  uniqueNumbers: boolean;
  expiresAt: number;
  tickets: GeneratedTicket[];
}

@Injectable()
export class TicketCreationService {
  // Per-process signing key: preview references are not login/admin credentials.
  // Restarting the API intentionally invalidates outstanding previews.
  private readonly signingKey = randomBytes(32);

  constructor(private readonly prisma: PrismaService) {}

  private async eligibleCampaign(tx: Prisma.TransactionClient, campaignId: string, organizationId: string) {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.organizationId !== organizationId || campaign.legacySample) throw new NotFoundException('Campanha não encontrada.');
    if (!['DRAFT', 'OPEN'].includes(campaign.status) || (campaign.closesAt && campaign.closesAt <= new Date())) throw new ConflictException('A campanha está encerrada ou indisponível.');
    return campaign;
  }

  async preview(campaignId: string, input: GenerationInput, organizationId: string) {
    const tickets = await this.prisma.$transaction(async tx => {
      await this.eligibleCampaign(tx, campaignId, organizationId);
      if (await tx.ticket.count({ where: { campaignId } }) + input.quantity > 2500) throw new ConflictException('Limite de 2.500 bilhetes por campanha.');
      const stock = await tx.ticket.findMany({ where: { campaignId }, select: { serial: true, numbers: { select: { value: true } } } });
      return generateTickets(input, stock);
    });
    const payload: PreviewPayload = { version: 1, batchId: randomUUID(), campaignId, uniqueNumbers: true, expiresAt: Date.now() + 15 * 60 * 1000, tickets };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.signingKey).update(encoded).digest('base64url');
    return { token: `${encoded}.${signature}`, batchId: payload.batchId, campaignId, expiresAt: new Date(payload.expiresAt).toISOString(), tickets };
  }

  private decode(token: string): PreviewPayload {
    if (typeof token !== 'string' || token.length > 400000) throw new BadRequestException('Prévia inválida.');
    const parts = token.split('.');
    if (parts.length !== 2) throw new BadRequestException('Prévia inválida.');
    const expected = createHmac('sha256', this.signingKey).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException('Prévia inválida ou API reiniciada. Gere outra prévia.');
    let payload: PreviewPayload;
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as PreviewPayload; }
    catch { throw new BadRequestException('Prévia inválida.'); }
    if (payload.version !== 1 || !Array.isArray(payload.tickets) || payload.tickets.length < 1 || payload.tickets.length > 1000) throw new BadRequestException('Prévia inválida.');
    if (payload.expiresAt <= Date.now()) throw new GoneException('A prévia expirou. Gere uma nova.');
    return payload;
  }

  async confirm(token: string, organizationId: string) {
    const payload = this.decode(token);
    try { return await this.prisma.$transaction(async tx => {
      // Serialize all confirmations for this campaign. Parameters stay bound, never
      // concatenated into SQL. Unique constraints also reject conflicting serials.
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${payload.campaignId}::uuid FOR UPDATE`;
      await this.eligibleCampaign(tx, payload.campaignId, organizationId);
      const ids = payload.tickets.map(ticket => ticket.id);
      const existing = await tx.ticket.findMany({ where: { id: { in: ids }, campaignId: payload.campaignId }, select: { id: true } });
      if (existing.length === ids.length) return { batchId: payload.batchId, campaignId: payload.campaignId, created: ids.length, replayed: true, tickets: payload.tickets };
      if (existing.length) throw new ConflictException('O lote está inconsistente. Gere uma nova prévia.');
      if (await tx.ticket.count({ where: { campaignId: payload.campaignId } }) + ids.length > 2500) throw new ConflictException('Limite de 2.500 bilhetes por campanha.');
      const collision = await tx.ticket.findFirst({ where: { campaignId: payload.campaignId, serial: { in: payload.tickets.map(ticket => ticket.serial) } }, select: { id: true } });
      if (collision) throw new ConflictException('O estoque mudou e há seriais repetidos. Gere uma nova prévia.');
      {
        const conflict = await tx.ticketNumber.findFirst({ where: { ticket: { campaignId: payload.campaignId }, value: { in: payload.tickets.flatMap(ticket => ticket.numbers) } }, select: { id: true } });
        if (conflict) throw new ConflictException('O estoque mudou e há números repetidos. Gere uma nova prévia.');
      }
      await tx.ticket.createMany({ data: payload.tickets.map(ticket => ({ id: ticket.id, campaignId: payload.campaignId, serial: ticket.serial, status: 'AVAILABLE' as const })) });
      await tx.ticketNumber.createMany({ data: payload.tickets.flatMap(ticket => ticket.numbers.map((value, index) => ({ id: randomUUID(), ticketId: ticket.id, campaignId: payload.campaignId, position: index + 1, value }))) });
      return { batchId: payload.batchId, campaignId: payload.campaignId, created: ids.length, replayed: false, tickets: payload.tickets };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 20000 }); } catch (error) { ticketConflict(error); }
  }
}
