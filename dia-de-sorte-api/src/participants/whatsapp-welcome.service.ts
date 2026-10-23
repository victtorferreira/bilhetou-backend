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

export function welcomeText(name: string) {
  return `Olá, ${name.split(' ')[0]}! 👋 Bem-vindo ao Bilhetou. Seu cadastro foi realizado com sucesso!\n\nEsta é a confirmação de cadastro que você solicitou no site.`;
}

@Injectable()
export class WhatsappWelcomeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappWelcomeService.name);
  private config: ReturnType<typeof wahaConfig> = null;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.config = wahaConfig();
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

  private async request(path: string, body?: unknown) {
    const config = this.config!;
    return fetch(`${config.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Api-Key': config.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  }

  async processNext() {
    if (!this.config) return;
    const now = new Date();
    // A crash after the POST may have delivered the message. Never resend blindly.
    await this.prisma.whatsappWelcome.updateMany({
      where: { status: 'PROCESSING', lockedAt: { lt: new Date(now.getTime() - 120000) } },
      data: { status: 'UNKNOWN', lastError: 'Processamento interrompido; confira no WAHA antes de reenviar.' },
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
    let chatId: string;
    try {
      const sessionResponse = await this.request(`/api/sessions/${encodeURIComponent(this.config.session)}`);
      if (!sessionResponse.ok) throw new Error(`SESSION_HTTP_${sessionResponse.status}`);
      const session = await sessionResponse.json() as { status?: string };
      if (session.status !== 'WORKING') throw new Error('SESSION_NOT_WORKING');
      // Ask WhatsApp for the canonical chatId (including Brazilian ninth-digit differences).
      const params = new URLSearchParams({ phone: `55${message.phone}`, session: this.config.session });
      const contactResponse = await this.request(`/api/contacts/check-exists?${params}`);
      if (!contactResponse.ok) throw new Error(`CONTACT_HTTP_${contactResponse.status}`);
      const contact = await contactResponse.json() as { numberExists?: boolean; chatId?: string };
      if (contact.numberExists === false) {
        await this.finish(message, 'FAILED', 'Número não encontrado no WhatsApp.');
        return;
      }
      if (contact.numberExists !== true || typeof contact.chatId !== 'string' || !/^\d+@(c\.us|lid)$/.test(contact.chatId)) throw new Error('INVALID_CONTACT_RESPONSE');
      chatId = contact.chatId;
    } catch {
      // No send has occurred: these retries are safe.
      const retry = message.attempts < maxAttempts;
      await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: {
        status: retry ? 'PENDING' : 'FAILED', lockedAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** (message.attempts - 1))),
        lastError: 'WAHA indisponível, sessão desconectada ou consulta de contato falhou.',
      } });
      this.logger.warn(`Boas-vindas ${message.id}: ${retry ? 'nova tentativa agendada' : 'tentativas esgotadas'}.`);
      return;
    }

    try {
      const response = await this.request('/api/sendText', { session: this.config.session, chatId, text: welcomeText(message.name) });
      if (!response.ok) {
        // Server errors can occur after sending. Treat them as ambiguous.
        await this.finish(message, response.status >= 500 ? 'UNKNOWN' : 'FAILED', `SEND_HTTP_${response.status}`);
        return;
      }
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== 'string' || !result.id) {
        await this.finish(message, 'UNKNOWN', 'WAHA respondeu sem identificador; confira antes de reenviar.');
        return;
      }
      await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: {
        status: 'SENT', sentAt: new Date(), lockedAt: null, providerMessageId: result.id, lastError: null,
      } });
    } catch {
      await this.finish(message, 'UNKNOWN', 'Resultado de envio incerto; confira no WAHA antes de reenviar.');
    }
  }

  private async finish(message: WhatsappWelcome, status: string, lastError: string) {
    await this.prisma.whatsappWelcome.update({ where: { id: message.id }, data: { status, lastError, lockedAt: null } });
    this.logger.warn(`Boas-vindas ${message.id}: ${status}.`);
  }
}
