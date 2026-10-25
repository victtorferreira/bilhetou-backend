import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ParticipantService } from '../participants/participant.service';
import type { ZettpayPayment } from '../generated/prisma/client';
import { reaisToCents, validPayerDocument, verifyZettpaySignature, zettpayConfiguration, ZettpayClient, zettpayId } from './zettpay.client';

@Injectable()
export class ZettpayService {
  constructor(private readonly prisma: PrismaService, private readonly participants: ParticipantService, private readonly client: ZettpayClient) {}

  private async ownedOrder(token: string | undefined, id: string) {
    const identity = await this.participants.paymentIdentity(token);
    const order = await this.prisma.order.findFirst({ where: { id, participantId: identity.id, campaign: { organizationId: identity.organizationId, legacySample: false }, legacySample: false } });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return { order, identity };
  }
  private view(payment: ZettpayPayment | null) {
    return payment ? { id: payment.id, status: payment.status, amountCents: payment.amountCents, qrCode: payment.status === 'PENDING' ? payment.qrCode : null, paidAt: payment.paidAt, lastError: payment.lastError } : null;
  }
  async current(token: string | undefined, orderId: string) {
    const { order } = await this.ownedOrder(token, orderId);
    const payment = await this.prisma.zettpayPayment.findUnique({ where: { orderId } });
    return { order: { id: order.id, totalCents: order.totalCents, quantity: order.quantity, paymentRequired: order.paymentRequired, paymentStatus: order.paymentStatus }, payment: this.view(payment) };
  }
  async create(token: string | undefined, orderId: string, input: { payerEmail: string; payerDocument: string }) {
    zettpayConfiguration();
    const { order, identity } = await this.ownedOrder(token, orderId);
    if (!order.paymentRequired) throw new ConflictException('Este pedido foi registrado antes da ativação do checkout Pix.');
    if (!Number.isSafeInteger(order.totalCents) || order.totalCents < 100) throw new BadRequestException('O valor mínimo do Pix é R$ 1,00.');
    if (!validPayerDocument(input.payerDocument)) throw new BadRequestException('Informe um CPF ou CNPJ válido do pagador.');
    const payerEmail = input.payerEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail) || payerEmail.length > 254) throw new BadRequestException('Informe um e-mail válido do pagador.');
    let payment: ZettpayPayment;
    try {
      payment = await this.prisma.zettpayPayment.create({ data: { orderId, amountCents: order.totalCents } });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      // A second request only reconciles the existing charge; it never POSTs another one.
      return this.check(token, orderId);
    }
    try {
      const data = await this.client.create({ id: payment.id, orderId, amountCents: payment.amountCents, payerName: identity.name, payerEmail, payerDocument: input.payerDocument.replace(/\D/g, '') });
      await this.apply(payment, data);
    } catch (error) {
      const code = error instanceof Error && /^ZETTPAY_(?:AUTH_HTTP_\d{3}|HTTP_\d{3}|AUTH_INVALID|INVALID_RESPONSE|REQUEST_UNCERTAIN|TRANSACTION_MISMATCH)$/.test(error.message) ? `${error.message}. ` : '';
      await this.prisma.zettpayPayment.updateMany({ where: { id: payment.id, status: { not: 'PAID' } }, data: { status: 'UNKNOWN', lastError: `${code}Confirmação da cobrança pendente. Consulte novamente; não crie outro pedido para repetir o pagamento.` } });
    }
    return this.current(token, orderId);
  }

  private async apply(payment: ZettpayPayment, data: any) {
    const config = zettpayConfiguration();
    const providerId = zettpayId(data?.id);
    if (!providerId || (payment.providerId && payment.providerId !== providerId) || data.external_id !== payment.id || reaisToCents(data.amount) !== payment.amountCents || (data.currency !== undefined && data.currency !== 'BRL') || typeof data.status !== 'string' || !/^[A-Za-z_]{2,64}$/.test(data.status)) throw new BadGatewayException('ZETTPAY_TRANSACTION_MISMATCH');
    const paid = data.status === config.paidStatus;
    const qrCode = typeof data.qr_code === 'string' && data.qr_code.startsWith('000201') && data.qr_code.length <= 10000 ? data.qr_code : null;
    // One transaction commits both the provider result and the order's payment state.
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ZettpayPayment" WHERE id = ${payment.id}::uuid FOR UPDATE`;
      const current = await tx.zettpayPayment.findUniqueOrThrow({ where: { id: payment.id } });
      const alreadyPaid = current.status === 'PAID';
      await tx.zettpayPayment.update({ where: { id: payment.id }, data: {
        providerId, providerStatus: alreadyPaid ? current.providerStatus : data.status,
        status: paid || alreadyPaid ? 'PAID' : data.status === 'pending' && (qrCode || current.qrCode) ? 'PENDING' : 'UNKNOWN',
        ...(qrCode ? { qrCode } : {}),
        ...(paid && !current.paidAt ? { paidAt: new Date() } : {}),
        lastError: !paid && !alreadyPaid && (data.status !== 'pending' || (!qrCode && !current.qrCode)) ? 'Cobrança em conferência. Consulte o pagamento novamente.' : null,
      } });
      if (paid || alreadyPaid) await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: 'PAID' } });
    });
  }

  private async reconcile(payment: ZettpayPayment) {
    const data = await this.client.lookup(payment.id);
    // A 404 is not proof that an earlier timed-out POST cannot still complete.
    if (!data) return;
    await this.apply(payment, data);
  }
  async check(token: string | undefined, orderId: string) {
    await this.ownedOrder(token, orderId);
    zettpayConfiguration();
    const payment = await this.prisma.zettpayPayment.findUnique({ where: { orderId } });
    if (payment && payment.status !== 'PAID') await this.reconcile(payment);
    return this.current(token, orderId);
  }
  async webhook(signature: unknown, rawBody: Buffer | undefined, body: unknown) {
    const config = zettpayConfiguration();
    if (!verifyZettpaySignature(rawBody, signature, config.signingSecret)) throw new ForbiddenException('Assinatura de webhook inválida ou expirada.');
    const event = body as { type?: unknown; external_id?: unknown; id?: unknown; status?: unknown };
    if (!event || event.type !== 'cashin') return { received: true, ignored: true };
    if (typeof event.external_id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(event.external_id)) return { received: true, ignored: true };
    const payment = await this.prisma.zettpayPayment.findUnique({ where: { id: event.external_id } });
    if (!payment) return { received: true, ignored: true };
    const eventId = `zettpay:${createHash('sha256').update(rawBody!).digest('hex')}`;
    if (await this.prisma.paymentWebhookEvent.findUnique({ where: { id: eventId } })) return { received: true };
    const data = await this.client.lookup(payment.id);
    if (!data) throw new ServiceUnavailableException('Transação ainda não disponível para consulta.');
    // Body fields are never proof of receipt; lookup validates value, reference and status.
    if (zettpayId(event.id) !== zettpayId(data.id)) throw new BadGatewayException('ZETTPAY_TRANSACTION_MISMATCH');
    await this.apply(payment, data);
    if (event.status === config.paidStatus && data.status !== config.paidStatus && payment.status !== 'PAID') throw new ServiceUnavailableException('Pagamento ainda não confirmado na consulta.');
    await this.prisma.paymentWebhookEvent.upsert({ where: { id: eventId }, create: { id: eventId }, update: {} });
    return { received: true };
  }
}
