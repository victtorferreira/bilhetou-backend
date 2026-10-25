import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { ParticipantSelectionDto } from './participant.dto';
import { zettpayConfiguration } from '../payments/zettpay.client';

const lifetime = 24 * 60 * 60 * 1000;
const empty = () => ({ participant: null, campaign: null, availableCount: 0, selectedIds: [] as string[], selectedTickets: [], selectionKey: '', orders: [] });
const numbers = { numbers: { orderBy: { position: 'asc' as const } } };
const ddds = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
export function normalizeRegistration(name: string, phone: string) {
  name = name.trim().replace(/\s+/g, ' ');
  phone = phone.replace(/\D/g, '');
  if (name.length > 120 || name.split(' ').length < 2 || !name.split(' ').every(p => /^[\p{L}][\p{L}\p{M}'’-]*$/u.test(p))) throw new BadRequestException('Informe seu nome completo.');
  if (!/^\d{2}9\d{8}$/.test(phone) || !ddds.has(phone.slice(0, 2))) throw new BadRequestException('Informe um WhatsApp válido com DDD e 11 dígitos.');
  return { name, phone };
}
type Session = Prisma.ParticipantSessionGetPayload<{ include: { participant: true } }>;
type Ticket = Prisma.TicketGetPayload<{ include: typeof numbers }>;

@Injectable()
export class ParticipantService {
  constructor(private readonly prisma: PrismaService) {}
  private organizationId() { return process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID || null; }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  token(cookie?: string) { return cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('bilhetou_participant='))?.slice('bilhetou_participant='.length); }
  cookie(token: string, logout = false) {
    return `bilhetou_participant=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${logout ? 0 : lifetime / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  }
  private async session(token: string | undefined, tx: Prisma.TransactionClient = this.prisma): Promise<Session> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Faça seu cadastro para continuar.');
    const session = await tx.participantSession.findUnique({ where: { tokenHash: this.hash(token) }, include: { participant: true } });
    if (!session || session.expiresAt <= new Date() || session.participant.organizationId !== this.organizationId()) throw new UnauthorizedException('Sua sessão expirou. Faça seu cadastro para continuar.');
    return session;
  }
  async paymentIdentity(token?: string) { return (await this.session(token)).participant; }
  private openCampaignWhere(organizationId: string): Prisma.CampaignWhereInput {
    return { organizationId, legacySample: false, status: 'OPEN', OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] };
  }
  private async defaultCampaign(tx: Prisma.TransactionClient, organizationId: string) {
    return tx.campaign.findFirst({ where: { ...this.openCampaignWhere(organizationId), ...(process.env.PUBLIC_CAMPAIGN_ID ? { id: process.env.PUBLIC_CAMPAIGN_ID } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }
  private ticket(ticket: Ticket, campaignName?: string, closesAt?: Date | null) {
    return { id: ticket.id, serial: ticket.serial, campaignId: ticket.campaignId, campaignName,
      numbers: ticket.numbers.map(n => n.value), issuedAt: ticket.assignedAt?.toISOString(),
      date: closesAt?.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? 'Data a definir', status: ticket.status === 'AVAILABLE' ? 'Disponível' : 'Atribuído' };
  }
  private async snapshot(session: Session, tx: Prisma.TransactionClient) {
    let campaign = session.campaignId ? await tx.campaign.findFirst({ where: { id: session.campaignId, organizationId: session.participant.organizationId, legacySample: false } }) : null;
    if (!campaign) {
      campaign = await this.defaultCampaign(tx, session.participant.organizationId);
      if (campaign) session = await tx.participantSession.update({ where: { id: session.id }, data: { campaignId: campaign.id, selectedIds: [], selectionKey: randomUUID() }, include: { participant: true } });
    }
    const open = campaign?.status === 'OPEN' && (!campaign.closesAt || campaign.closesAt > new Date());
    const availableCount = open ? await tx.ticket.count({ where: { campaignId: campaign!.id, status: 'AVAILABLE' } }) : 0;
    const selected = campaign ? await tx.ticket.findMany({ where: { campaignId: campaign.id, status: 'AVAILABLE', id: { in: session.selectedIds } }, include: numbers, orderBy: { serial: 'asc' } }) : [];
    const orders = await tx.order.findMany({ where: { participantId: session.participantId, legacySample: false, campaign: { organizationId: session.participant.organizationId, legacySample: false } }, include: { campaign: true, tickets: { include: numbers, orderBy: { serial: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return {
      participant: { id: session.participant.id, name: session.participant.name, phone: session.participant.phone, verification: 'unverified' },
      campaign: campaign ? { id: campaign.id, name: campaign.name, ticketPriceCents: campaign.ticketPriceCents, prizeCents: campaign.prizeCents, drawDate: campaign.closesAt?.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? 'Data a definir', status: campaign.status } : null,
      availableCount, selectedIds: selected.map(t => t.id), selectedTickets: selected.map(t => this.ticket(t, campaign?.name, campaign?.closesAt)), selectionKey: session.selectionKey,
      orders: orders.map(order => {
        const visible = !order.paymentRequired || order.paymentStatus === 'PAID' ? order.tickets : [];
        return { id: order.id, participantId: order.participantId, campaignId: order.campaignId, ticketIds: visible.map(t => t.id), totalCents: order.totalCents, quantity: order.quantity, createdAt: order.createdAt.toISOString(), idempotencyKey: order.idempotencyKey, status: 'registered', paymentRequired: order.paymentRequired ?? false, paymentStatus: order.paymentStatus || 'UNPAID', tickets: visible.map(t => this.ticket(t, order.campaign.name, order.campaign.closesAt)) };
      }),
    };
  }
  async current(token?: string) {
    if (!token) return empty();
    try {
      return await this.prisma.$transaction(async tx => this.snapshot(await this.session(token, tx), tx), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) { if (error instanceof UnauthorizedException) return empty(); throw error; }
  }
  async register(name: string, phone: string, previousToken?: string, whatsappConsent = false) {
    const input = normalizeRegistration(name, phone);
    const organizationId = this.organizationId();
    if (!organizationId) throw new ServiceUnavailableException('O cadastro aguarda a configuração da organização.');
    const token = randomBytes(32).toString('hex');
    const state = await this.prisma.$transaction(async tx => {
      if (!await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) throw new ServiceUnavailableException('A organização ainda não foi cadastrada.');
      const campaign = await this.defaultCampaign(tx, organizationId);
      if (!campaign) throw new ConflictException('Nenhuma campanha aberta. Aguarde a abertura de uma campanha.');
      // Never restore an identity just by matching an unverified phone number.
      let participant: { id: string } | null = null;
      if (previousToken) {
        try {
          const previous = await this.session(previousToken, tx);
          if (previous.participant.name === input.name && previous.participant.phone === input.phone) participant = previous.participant;
        } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
        await tx.participantSession.deleteMany({ where: { tokenHash: this.hash(previousToken) } });
      }
      participant ??= await tx.participant.create({ data: { organizationId, ...input } });
      if (whatsappConsent === true) {
        await tx.whatsappWelcome.createMany({
          data: [{ participantId: participant.id, organizationId, ...input, consentVersion: 'welcome-v1' }],
          skipDuplicates: true,
        });
      }
      const session = await tx.participantSession.create({ data: { tokenHash: this.hash(token), participantId: participant.id, campaignId: campaign.id, selectedIds: [], expiresAt: new Date(Date.now() + lifetime) }, include: { participant: true } });
      return this.snapshot(session, tx);
    });
    return { token, state };
  }
  async logout(token?: string) {
    if (token) await this.prisma.participantSession.deleteMany({ where: { tokenHash: this.hash(token) } });
    return empty();
  }
  private async lockedSession(token: string | undefined, tx: Prisma.TransactionClient) {
    const session = await this.session(token, tx);
    await tx.$queryRaw`SELECT id FROM "ParticipantSession" WHERE id = ${session.id}::uuid FOR UPDATE`;
    return this.session(token, tx);
  }
  private async campaign(session: Session, tx: Prisma.TransactionClient) {
    if (!session.campaignId) throw new ConflictException('Selecione uma campanha.');
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${session.campaignId}::uuid FOR UPDATE`;
    const campaign = await tx.campaign.findFirst({ where: { ...this.openCampaignWhere(session.participant.organizationId), id: session.campaignId } });
    if (!campaign) throw new ConflictException('A campanha não está aberta.');
    return campaign;
  }
  async select(token: string | undefined, input: ParticipantSelectionDto) {
    if ((input.quantity !== undefined) === (input.ticketIds !== undefined)) throw new BadRequestException('Informe quantidade ou bilhetes, somente uma opção.');
    return this.prisma.$transaction(async tx => {
      const session = await this.lockedSession(token, tx);
      const campaign = await this.campaign(session, tx);
      const selected = await tx.ticket.findMany({ where: { campaignId: campaign.id, status: 'AVAILABLE', ...(input.ticketIds ? { id: { in: input.ticketIds } } : {}) }, select: { id: true }, orderBy: { serial: 'asc' }, take: input.quantity ?? 1000 });
      if (selected.length !== (input.quantity ?? input.ticketIds!.length)) throw new ConflictException('Algum bilhete não está disponível nesta campanha. Atualize sua seleção.');
      const updated = await tx.participantSession.update({ where: { id: session.id }, data: { selectedIds: selected.map(t => t.id), selectionKey: randomUUID() }, include: { participant: true } });
      return this.snapshot(updated, tx);
    });
  }
  async changeCampaign(token: string | undefined, campaignId: string) {
    return this.prisma.$transaction(async tx => {
      const session = await this.lockedSession(token, tx);
      const campaign = await tx.campaign.findFirst({ where: { ...this.openCampaignWhere(session.participant.organizationId), id: campaignId } });
      if (!campaign) throw new ConflictException('Campanha indisponível.');
      const updated = await tx.participantSession.update({ where: { id: session.id }, data: { campaignId, selectedIds: [], selectionKey: randomUUID() }, include: { participant: true } });
      return this.snapshot(updated, tx);
    });
  }
  async tickets(token: string | undefined, page: number, query: string, selectedOnly: boolean) {
    return this.prisma.$transaction(async tx => {
      const session = await this.session(token, tx);
      const campaign = session.campaignId ? await tx.campaign.findFirst({ where: { ...this.openCampaignWhere(session.participant.organizationId), id: session.campaignId } }) : null;
      if (!campaign) return { items: [], total: 0, page: 1, totalPages: 1 };
      const where: Prisma.TicketWhereInput = { campaignId: campaign.id, status: 'AVAILABLE', ...(selectedOnly ? { id: { in: session.selectedIds } } : {}), OR: [{ serial: { contains: query.trim(), mode: 'insensitive' } }, { numbers: { some: { value: query.trim() } } }] };
      const total = await tx.ticket.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / 20));
      const current = Math.min(page, totalPages);
      const items = await tx.ticket.findMany({ where, include: numbers, orderBy: { serial: 'asc' }, skip: (current - 1) * 20, take: 20 });
      return { items: items.map(t => this.ticket(t, campaign.name, campaign.closesAt)), total, page: current, totalPages };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async confirm(token: string | undefined, key: string) {
    if (process.env.ZETTPAY_ENABLED === 'true') zettpayConfiguration();
    return this.prisma.$transaction(async tx => {
      const session = await this.lockedSession(token, tx);
      const previous = await tx.order.findUnique({ where: { participantId_idempotencyKey: { participantId: session.participantId, idempotencyKey: key } } });
      if (previous) return this.snapshot(session, tx);
      if (key !== session.selectionKey || !session.selectedIds.length) throw new ConflictException('A seleção mudou. Confira seus bilhetes antes de confirmar.');
      const campaign = await this.campaign(session, tx);
      const selected = await tx.ticket.findMany({ where: { id: { in: session.selectedIds }, campaignId: campaign.id, status: 'AVAILABLE' }, select: { id: true } });
      if (selected.length !== session.selectedIds.length) throw new ConflictException('Algum bilhete já foi atribuído. Escolha seus bilhetes novamente.');
      const order = await tx.order.create({ data: { campaignId: campaign.id, participantId: session.participantId, idempotencyKey: key, quantity: selected.length, totalCents: selected.length * campaign.ticketPriceCents, paymentRequired: process.env.ZETTPAY_ENABLED === 'true' } });
      const result = await tx.ticket.updateMany({ where: { id: { in: selected.map(t => t.id) }, campaignId: campaign.id, status: 'AVAILABLE' }, data: { status: 'ASSIGNED', orderId: order.id, assignedAt: new Date() } });
      if (result.count !== selected.length) throw new ConflictException('O estoque mudou. Escolha seus bilhetes novamente.');
      const updated = await tx.participantSession.update({ where: { id: session.id }, data: { selectedIds: [], selectionKey: randomUUID() }, include: { participant: true } });
      return this.snapshot(updated, tx);
    }, { timeout: 20000 });
  }
  async results(token?: string) {
    const session = await this.session(token);
    if (!session.campaignId) return [];
    return this.prisma.draw.findMany({ where: { campaignId: session.campaignId, campaign: { organizationId: session.participant.organizationId, legacySample: false } }, select: { id: true, reference: true, createdAt: true, results: { select: { number: true, position: true }, orderBy: { position: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
