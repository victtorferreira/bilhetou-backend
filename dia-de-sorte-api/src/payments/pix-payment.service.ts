import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { PixPayment } from '../generated/prisma/client';

const apiUrl = 'https://api.abacatepay.com/v2';
const statuses = new Set(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']);
// Public integrity key published by AbacatePay, not the webhook's authentication secret.
export const abacatepayWebhookPublicKey = 't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

export function pixConfiguration() {
  if (process.env.ABACATEPAY_ENABLED !== 'true') throw new ServiceUnavailableException('Cobranças Pix desativadas. Configure o backend para habilitar.');
  const environment = process.env.ABACATEPAY_ENVIRONMENT || 'sandbox';
  if (!['sandbox', 'production'].includes(environment)) throw new ServiceUnavailableException('ABACATEPAY_ENVIRONMENT deve ser sandbox ou production.');
  const key = process.env.ABACATEPAY_API_KEY?.trim() || '';
  const pattern = environment === 'production' ? /^(abc_)?prod_\S+$/ : /^(abc_)?dev_\S+$/;
  if (!pattern.test(key)) throw new ServiceUnavailableException('A chave AbacatePay não corresponde ao ambiente configurado.');
  const webhookSecret = process.env.ABACATEPAY_WEBHOOK_SECRET?.trim() || '';
  if (webhookSecret.length < 32) throw new ServiceUnavailableException('Configure ABACATEPAY_WEBHOOK_SECRET com pelo menos 32 caracteres.');
  return { environment, key, webhookSecret, devMode: environment === 'sandbox' };
}

@Injectable()
export class PixPaymentService {
  constructor(private readonly prisma: PrismaService) {}
  configuration() { const { environment } = pixConfiguration(); return { enabled: true, environment, minAmountCents: 100, maxAmountCents: 1000000 }; }

  private async request(path: string, body?: unknown) {
    const { key } = pixConfiguration();
    try {
      const response = await fetch(`${apiUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw new BadGatewayException(`PROVIDER_HTTP_${response.status}`);
      const result = await response.json();
      if (result?.success !== true || result.error || !result.data) throw new BadGatewayException('PROVIDER_INVALID_RESPONSE');
      return result.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException('PROVIDER_REQUEST_UNCERTAIN');
    }
  }

  list(organizationId: string) {
    return this.prisma.pixPayment.findMany({ where: { organizationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
      select: { id: true, description: true, amountCents: true, environment: true, status: true, createdAt: true, paidAt: true, lastError: true } });
  }
  async get(organizationId: string, id: string) {
    const row = await this.prisma.pixPayment.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Cobrança não encontrada.');
    return row;
  }

  async create(organizationId: string, input: { requestKey: string; description: string; amountCents: number }) {
    const config = pixConfiguration();
    const description = input.description.trim();
    if (description.length < 3 || description.length > 140 || !Number.isInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > 1000000) throw new BadRequestException('Informe descrição e valor entre R$ 1,00 e R$ 10.000,00.');
    // Persist the unique claim before contacting the provider. Never repeat an uncertain POST.
    const where = { organizationId_requestKey: { organizationId, requestKey: input.requestKey } };
    let row: PixPayment;
    try {
      row = await this.prisma.pixPayment.create({ data: { organizationId, requestKey: input.requestKey, environment: config.environment, description, amountCents: input.amountCents } });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      const existing = await this.prisma.pixPayment.findUnique({ where });
      if (!existing) throw error;
      if (existing.amountCents !== input.amountCents || existing.description !== description || existing.environment !== config.environment) throw new ConflictException('Esta referência já foi usada com outros dados.');
      return existing;
    }
    try {
      const data = await this.request('/transparents/create', { method: 'PIX', data: { amount: row.amountCents, description, expiresIn: 900, externalId: row.id, metadata: { paymentId: row.id } } });
      if (data.devMode !== config.devMode || data.amount !== row.amountCents || !/^pix_char_[\w-]+$/.test(data.id) || !statuses.has(data.status) || typeof data.brCode !== 'string' || !data.brCode || data.brCode.length > 10000 || !Number.isFinite(Date.parse(data.expiresAt))) throw new BadGatewayException('PROVIDER_CHARGE_MISMATCH');
      return await this.prisma.pixPayment.update({ where: { id: row.id }, data: { providerId: data.id, brCode: data.brCode, status: data.status, expiresAt: new Date(data.expiresAt), ...(data.status === 'PAID' ? { paidAt: new Date() } : {}) } });
    } catch (error) {
      // Even a local database write can fail after a charge was created remotely.
      const code = error instanceof Error && /^PROVIDER_(HTTP_\d{3}|INVALID_RESPONSE|CHARGE_MISMATCH|REQUEST_UNCERTAIN)$/.test(error.message) ? `${error.message}: ` : '';
      return this.prisma.pixPayment.update({ where: { id: row.id }, data: { status: 'UNKNOWN', lastError: `${code}Geração sem confirmação. Confira a referência interna no painel AbacatePay antes de criar outra cobrança.` } });
    }
  }

  async check(organizationId: string, id: string) {
    const row = await this.get(organizationId, id);
    const config = pixConfiguration();
    if (row.environment !== config.environment) throw new ConflictException('Selecione o mesmo ambiente usado para gerar esta cobrança.');
    if (!row.providerId) return row;
    const data = await this.request(`/transparents/check?id=${encodeURIComponent(row.providerId)}`);
    if (data.id !== row.providerId || !statuses.has(data.status)) throw new BadGatewayException('PROVIDER_STATUS_MISMATCH');
    // A delayed PENDING/EXPIRED response must never overwrite a confirmed payment.
    if (data.status === 'PAID') await this.prisma.pixPayment.updateMany({ where: { id: row.id, paidAt: null }, data: { status: 'PAID', paidAt: new Date(), lastError: null } });
    else await this.prisma.pixPayment.updateMany({ where: { id: row.id, paidAt: null }, data: { status: data.status } });
    return this.get(organizationId, id);
  }

  async webhook(secret: unknown, signature: unknown, rawBody: Buffer | undefined, body: unknown) {
    const config = pixConfiguration();
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (typeof secret !== 'string' || !timingSafeEqual(hash(secret), hash(config.webhookSecret))) throw new ForbiddenException('Webhook não autorizado.');
    const expected = rawBody ? createHmac('sha256', abacatepayWebhookPublicKey).update(rawBody).digest('base64') : '';
    if (typeof signature !== 'string' || !rawBody || !/^[A-Za-z0-9+/]{43}=$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ForbiddenException('Assinatura de webhook inválida.');
    const event = body as { id?: unknown; event?: unknown; devMode?: unknown; data?: unknown };
    if (!event || typeof event.id !== 'string' || !/^[\w-]{1,140}$/.test(event.id) || event.devMode !== config.devMode) throw new BadRequestException('Evento ou ambiente inválido.');
    if (event.event !== 'transparent.completed') return { received: true, ignored: true };
    const eventId = `${config.environment}:${event.id}`;
    if (await this.prisma.paymentWebhookEvent.findUnique({ where: { id: eventId } })) return { received: true };
    // Payload fields may evolve. Extract only Pix identifiers, then verify every status via API.
    const ids = new Set<string>();
    let visited = 0;
    const collect = (value: unknown, depth = 0) => {
      if (++visited > 256 || depth > 5) return;
      if (typeof value === 'string' && /^pix_char_[\w-]{1,140}$/.test(value)) ids.add(value);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child, depth + 1);
    };
    collect(event.data);
    if (!ids.size) throw new BadRequestException('Evento sem identificador Pix.');
    const rows = await this.prisma.pixPayment.findMany({ where: { providerId: { in: [...ids] }, environment: config.environment } });
    // Another application may share this merchant account. Do not acknowledge unknown IDs
    // as processed: a webhook can also race our providerId database write.
    if (!rows.length) throw new ServiceUnavailableException('Cobrança ainda não localizada.');
    for (const row of rows) {
      const updated = await this.check(row.organizationId, row.id);
      if (updated.status !== 'PAID') throw new ServiceUnavailableException('Pagamento ainda não confirmado pela API.');
    }
    await this.prisma.paymentWebhookEvent.upsert({ where: { id: eventId }, create: { id: eventId }, update: {} });
    return { received: true };
  }
}
