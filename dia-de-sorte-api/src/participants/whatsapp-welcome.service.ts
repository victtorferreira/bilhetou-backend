import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { WhatsappWelcome } from '../generated/prisma/client';

const maxAge = 24 * 60 * 60 * 1000;
const maxAttempts = 10;

export function wahaConfig() {
  if (process.env.WAHA_ENABLED !== 'true') return null;
  const url = new URL(process.env.WAHA_BASE_URL || '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('WAHA_BASE_URL deve ser uma URL HTTP(S), sem credenciais ou parâmetros.');
  const apiKey = process.env.WAHA_API_KEY?.trim();
  if (!apiKey) throw new Error('Configure WAHA_API_KEY no backend.');
  return { baseUrl: url.toString().replace(/\/$/, ''), apiKey, session: process.env.WAHA_SESSION?.trim() || 'default' };
}

export function whatsappConfig() {
  const provider = process.env.WHATSAPP_PROVIDER?.trim() || 'waha';
  if (!['waha', 'evolution'].includes(provider)) throw new Error('WHATSAPP_PROVIDER deve ser waha ou evolution.');
  if (provider === 'waha') {
    const config = wahaConfig();
    return config ? { ...config, provider: 'waha' as const } : null;
  }
  if (process.env.WHATSAPP_ENABLED !== 'true') return null;
  const url = new URL(process.env.EVOLUTION_BASE_URL || '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('EVOLUTION_BASE_URL deve ser HTTP(S), sem credenciais ou parâmetros.');
  const apiKey = process.env.EVOLUTION_API_KEY?.trim();
  const session = process.env.EVOLUTION_INSTANCE?.trim();
  if (!apiKey || !session) throw new Error('Configure EVOLUTION_API_KEY e EVOLUTION_INSTANCE no backend.');
  return { provider: 'evolution' as const, baseUrl: url.toString().replace(/\/$/, ''), apiKey, session };
}

export function welcomeText(name: string) {
  return `Olá, ${name.split(' ')[0]}! 👋\nSeu cadastro no *Bilhetou* foi realizado com sucesso! 🎟️\n\nQuando quiser voltar ao site e consultar seus bilhetes, acesse:\nhttps://bilhetou.vercel.app\n\nGuarde este link para acessar quando precisar. 😊`;
}

@Injectable()
export class WhatsappWelcomeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappWelcomeService.name);
  private config: ReturnType<typeof whatsappConfig> = null;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.config = whatsappConfig();
    if (!this.config) return;
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.processNext()
        .catch(() => this.logger.error('Falha ao processar a fila de boas-vindas. Verifique o banco e a migração.'))
        .finally(() => { this.running = undefined; });
    }, 5000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private async request(path: string, body?: unknown, timeoutMs = 10000) {
    const config = this.config!;
    return fetch(`${config.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [config.provider === 'evolution' ? 'apikey' : 'X-Api-Key']: config.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  }

  async processNext() {
    if (!this.config) return;
    const now = new Date();
    // A crash after the POST may have delivered the message. Never resend blindly.
    await this.prisma.whatsappWelcome.updateMany({
      where: { status: 'PROCESSING', lockedAt: { lt: new Date(now.getTime() - 120000) } },
      data: { status: 'UNKNOWN', lastError: 'Processamento interrompido; confira no provedor antes de reenviar.' },
    });
    await this.prisma.whatsappWelcome.updateMany({
      where: { status: 'PENDING', consentedAt: { lt: new Date(now.getTime() - maxAge) } },
      data: { status: 'EXPIRED', lastError: 'Confirmação expirada após 24 horas.' },
    });
    // Claim atomically: multiple API instances cannot send the same row.
    const rows = await this.prisma.$queryRaw<WhatsappWelcome[]>`
      UPDATE "WhatsappWelcome" SET "status" = 'PROCESSING', "lockedAt" = NOW(), "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "WhatsappWelcome"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
        ORDER BY "nextAttemptAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING *`;
    if (!rows.length) return;
    const message = rows[0];
    const recipient = await this.prisma.participant.findUnique({ where: { id: message.participantId }, select: { organizationId: true, phone: true, phoneVerifiedAt: true } });
    if (!recipient?.phoneVerifiedAt || recipient.organizationId !== message.organizationId || recipient.phone !== message.phone) {
      await this.finish(message, 'CANCELLED', 'Envio suspenso: telefone sem verificação de titularidade.');
      return;
    }
    let chatId: string;
    let stage = 'SESSION';
    const evolution = this.config.provider === 'evolution';
    const instance = encodeURIComponent(this.config.session);
    try {
      const sessionResponse = await this.request(evolution ? `/instance/connectionState/${instance}` : `/api/sessions/${instance}`);
      if (!sessionResponse.ok) throw new Error(`SESSION_HTTP_${sessionResponse.status}`);
      const session = await sessionResponse.json() as { status?: string; instance?: { state?: string } };
      if (evolution ? session.instance?.state !== 'open' : session.status !== 'WORKING') throw new Error('SESSION_NOT_WORKING');
      stage = 'CONTACT';
      // Ask WhatsApp for the canonical chatId (including Brazilian ninth-digit differences).
      const params = new URLSearchParams({ phone: `55${message.phone}`, session: this.config.session });
      const contactResponse = evolution
        ? await this.request(`/chat/whatsappNumbers/${instance}`, { numbers: [`55${message.phone}`] }, 60000)
        : await this.request(`/api/contacts/check-exists?${params}`, undefined, 60000);
      if (!contactResponse.ok) throw new Error(`CONTACT_HTTP_${contactResponse.status}`);
      const result = await contactResponse.json();
      const contact: { numberExists?: boolean; chatId?: string } = evolution
        ? (Array.isArray(result) && result.length === 1 ? { numberExists: result[0]?.exists, chatId: result[0]?.jid } : {})
        : (result ?? {});
      if (contact.numberExists === false) {
        await this.finish(message, 'FAILED', 'Número não encontrado no WhatsApp.');
        return;
      }
      const validChatId = evolution ? /^\d+@(s\.whatsapp\.net|lid)$/ : /^\d+@(c\.us|lid)$/;
      if (contact.numberExists !== true || typeof contact.chatId !== 'string' || !validChatId.test(contact.chatId)) throw new Error('INVALID_CONTACT_RESPONSE');
      chatId = contact.chatId;
    } catch (error) {
      // No send has occurred: these retries are safe.
      // Store only controlled codes: fetch errors may contain private request details.
      const reason = error instanceof Error && /^(SESSION_HTTP_\d{3}|SESSION_NOT_WORKING|CONTACT_HTTP_\d{3}|INVALID_CONTACT_RESPONSE)$/.test(error.message)
        ? error.message
        : `${stage}_${error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'REQUEST_FAILED'}`;
      const retry = message.attempts < maxAttempts;
      await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: {
        status: retry ? 'PENDING' : 'FAILED', lockedAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** (message.attempts - 1))),
        lastError: reason,
      } });
      this.logger.warn(`Boas-vindas ${message.id}: ${reason}; ${retry ? 'nova tentativa agendada' : 'tentativas esgotadas'}.`);
      return;
    }

    try {
      const response = evolution
        ? await this.request(`/message/sendText/${instance}`, { number: chatId, text: welcomeText(message.name) })
        : await this.request('/api/sendText', { session: this.config.session, chatId, text: welcomeText(message.name) });
      if (!response.ok) {
        // Server errors can occur after sending. Treat them as ambiguous.
        await this.finish(message, response.status >= 500 ? 'UNKNOWN' : 'FAILED', `SEND_HTTP_${response.status}`);
        return;
      }
      const result = await response.json() as { id?: unknown; key?: { id?: unknown } };
      const providerMessageId = evolution ? result?.key?.id : result?.id;
      if (typeof providerMessageId !== 'string' || !providerMessageId) {
        await this.finish(message, 'UNKNOWN', 'Provedor respondeu sem identificador; confira antes de reenviar.');
        return;
      }
      await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: {
        status: 'SENT', sentAt: new Date(), lockedAt: null, providerMessageId, lastError: null,
      } });
    } catch {
      await this.finish(message, 'UNKNOWN', 'Resultado de envio incerto; confira no provedor antes de reenviar.');
    }
  }

  private async finish(message: WhatsappWelcome, status: string, lastError: string) {
    await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: { status, lastError, lockedAt: null } });
    this.logger.warn(`Boas-vindas ${message.id}: ${status}.`);
  }
}
