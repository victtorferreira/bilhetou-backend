import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

const base = 'https://api.zettpay.io/api';
export function zettpayConfiguration() {
  if (process.env.ZETTPAY_ENABLED !== 'true') throw new ServiceUnavailableException('Pagamento Zettpay desativado.');
  const clientId = process.env.ZETTPAY_CLIENT_ID?.trim();
  const clientSecret = process.env.ZETTPAY_CLIENT_SECRET?.trim();
  const signingSecret = process.env.ZETTPAY_WEBHOOK_SIGNING_SECRET?.trim();
  const paidStatus = process.env.ZETTPAY_PAID_STATUS?.trim();
  if (!clientId || !clientSecret) throw new ServiceUnavailableException('Configure as credenciais Zettpay no backend.');
  if (!signingSecret?.startsWith('whsec_') || signingSecret.length < 20) throw new ServiceUnavailableException('Configure o signing_secret emitido pela Zettpay para o webhook.');
  if (!paidStatus || !/^[A-Za-z_]{2,64}$/.test(paidStatus) || ['pending', 'processing', 'failed', 'rejected', 'cancelled', 'canceled', 'expired'].includes(paidStatus.toLowerCase())) throw new ServiceUnavailableException('Configure ZETTPAY_PAID_STATUS com o status documentado de cash-in pago.');
  return { clientId, clientSecret, signingSecret, paidStatus };
}

export function reaisToCents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function zettpayId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}
export function validPayerDocument(value: string) {
  const document = value.replace(/\D/g, '');
  if (!/^(\d{11}|\d{14})$/.test(document) || /^(\d)\1+$/.test(document)) return false;
  const digits = [...document].map(Number);
  const check = (length: number, weights: number[]) => {
    const remainder = digits.slice(0, length).reduce((sum, digit, i) => sum + digit * weights[i], 0) % 11;
    return digits[length] === (remainder < 2 ? 0 : 11 - remainder);
  };
  return document.length === 11
    ? check(9, [10,9,8,7,6,5,4,3,2]) && check(10, [11,10,9,8,7,6,5,4,3,2])
    : check(12, [5,4,3,2,9,8,7,6,5,4,3,2]) && check(13, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
}
export function verifyZettpaySignature(raw: Buffer | undefined, header: unknown, secret: string, now = Date.now()) {
  if (!raw || typeof header !== 'string' || header.length > 2048) return false;
  const parts = header.split(',').map(part => part.trim());
  const timestamps = parts.filter(part => part.startsWith('t='));
  if (timestamps.length !== 1 || !/^t=\d{10,11}$/.test(timestamps[0])) return false;
  const timestamp = timestamps[0].slice(2);
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return parts.filter(part => part.startsWith('v1=')).some(part => {
    const signature = part.slice(3);
    return /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
}

@Injectable()
export class ZettpayClient {
  private token?: { value: string; expires: number; credentials: string };
  private pending?: Promise<string>;
  private async accessToken() {
    const config = zettpayConfiguration();
    const credentials = `${config.clientId}\0${config.clientSecret}`;
    if (this.token?.credentials === credentials && this.token.expires > Date.now()) return this.token.value;
    if (!this.pending) this.pending = (async () => {
      const response = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret }),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new BadGatewayException(`ZETTPAY_AUTH_HTTP_${response.status}`);
      const data = await response.json();
      if (typeof data?.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer') throw new BadGatewayException('ZETTPAY_AUTH_INVALID');
      const lifetime = typeof data.expires_in === 'number' && data.expires_in > 30 ? Math.min(data.expires_in - 30, 3600) : 60;
      this.token = { value: data.access_token, credentials, expires: Date.now() + lifetime * 1000 };
      return data.access_token as string;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async request(path: string, body?: unknown, idempotencyKey?: string) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.accessToken();
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (response.status === 401 && attempt === 0) { this.token = undefined; continue; }
        if (response.status === 404 && body === undefined) return null;
        if (!response.ok) throw new BadGatewayException(`ZETTPAY_HTTP_${response.status}`);
        const result = await response.json();
        if (!result || result.success === false || result.error) throw new BadGatewayException('ZETTPAY_INVALID_RESPONSE');
        return result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : result;
      }
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('ZETTPAY_REQUEST_UNCERTAIN');
    }
  }
  create(input: { id: string; amountCents: number; orderId: string; payerName: string; payerEmail: string; payerDocument: string }) {
    return this.request('/transactions', {
      amount: Number((input.amountCents / 100).toFixed(2)), description: `Pedido ${input.orderId}`,
      payer_name: input.payerName, payer_email: input.payerEmail, payer_document: input.payerDocument,
      external_id: input.id, additional_fields: { order_id: input.orderId },
    }, `bilhetou-${input.id}`);
  }
  lookup(externalId: string) { return this.request(`/transactions/lookup?external_id=${encodeURIComponent(externalId)}`); }
}
