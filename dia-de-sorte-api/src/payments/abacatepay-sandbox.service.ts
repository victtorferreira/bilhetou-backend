import { BadGatewayException, BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const baseUrl = 'https://api.abacatepay.com/v2';
const amount = 200;
const statuses = new Set(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']);
type Receipt = { id: string; organizationId: string; expires: number };

@Injectable()
export class AbacatepaySandboxService {
  private readonly creating = new Set<string>();

  private key() {
    if (process.env.ABACATEPAY_SANDBOX_ENABLED !== 'true') throw new ServiceUnavailableException('Teste AbacatePay desativado. Configure ABACATEPAY_SANDBOX_ENABLED=true no backend.');
    const key = process.env.ABACATEPAY_SANDBOX_API_KEY?.trim();
    if (!key || !/^(abc_)?dev_\S+$/.test(key)) throw new ServiceUnavailableException('Configure uma chave de sandbox dev_ ou abc_dev_ em ABACATEPAY_SANDBOX_API_KEY. Chaves de produção não são aceitas.');
    return key;
  }

  configuration() {
    this.key();
    return { enabled: true, environment: 'sandbox', amountCents: amount };
  }

  private async request(key: string, path: string, body?: unknown) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (response.status === 401) throw new BadGatewayException('A chave de teste foi recusada pelo AbacatePay. Confira a variável no backend.');
      if (response.status === 403) throw new BadGatewayException('A chave precisa das permissões TRANSPARENT:CREATE e TRANSPARENT:READ.');
      if (!response.ok) throw new BadGatewayException(`AbacatePay respondeu HTTP ${response.status}. Confira a cobrança no painel antes de repetir.`);
      const result = await response.json();
      if (result?.success !== true || result.error || !result.data || typeof result.data !== 'object') throw new BadGatewayException('Resposta inválida do AbacatePay. Confira o painel antes de repetir.');
      return result.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Do not disclose provider bodies, tokens, or fetch errors in responses/logs.
      throw new BadGatewayException('Não foi possível concluir a chamada ao AbacatePay. Confira o painel antes de repetir; não há repetição automática.');
    }
  }

  private sign(key: string, payload: string) {
    return createHmac('sha256', key).update(`bilhetou-abacatepay-sandbox:${payload}`).digest('base64url');
  }

  private receipt(key: string, token: string, organizationId: string): Receipt {
    if (typeof token !== 'string' || token.length > 2048) throw new BadRequestException('Referência de teste inválida.');
    const [payload, signature, extra] = token.split('.');
    const expected = this.sign(key, payload || '');
    if (extra || !signature || !/^[a-zA-Z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ForbiddenException('Referência de teste inválida.');
    let receipt: Receipt;
    try { receipt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new BadRequestException('Referência de teste inválida.'); }
    if (!receipt || receipt.organizationId !== organizationId || !/^pix_char_[a-zA-Z0-9_-]+$/.test(receipt.id) || !Number.isFinite(receipt.expires) || receipt.expires <= Date.now()) throw new ForbiddenException('Teste expirado ou de outra organização. Gere um novo teste.');
    return receipt;
  }

  async create(organizationId: string) {
    const key = this.key();
    if (this.creating.has(organizationId)) throw new BadRequestException('Já existe uma geração de Pix em andamento. Aguarde.');
    this.creating.add(organizationId);
    try {
      const data = await this.request(key, '/transparents/create', { method: 'PIX', data: { amount, expiresIn: 900, description: 'Teste de integração Bilhetou — sandbox', externalId: `bilhetou-sandbox-${randomUUID()}` } });
      if (data.devMode !== true || data.amount !== amount || !/^pix_char_[a-zA-Z0-9_-]+$/.test(data.id) || !statuses.has(data.status) || typeof data.brCode !== 'string' || !data.brCode || data.brCode.length > 10000 || !Number.isFinite(Date.parse(data.expiresAt))) throw new BadGatewayException('Cobrança recusada: a resposta deve ser Pix sandbox de R$ 2,00 com QR Code válido.');
      const payload = Buffer.from(JSON.stringify({ id: data.id, organizationId, expires: Date.now() + 24 * 3600000 })).toString('base64url');
      return { id: data.id, status: data.status, amountCents: amount, devMode: true, brCode: data.brCode, expiresAt: data.expiresAt, token: `${payload}.${this.sign(key, payload)}` };
    } finally { this.creating.delete(organizationId); }
  }

  async check(organizationId: string, token: string) {
    const key = this.key();
    const receipt = this.receipt(key, token, organizationId);
    const data = await this.request(key, `/transparents/check?id=${encodeURIComponent(receipt.id)}`);
    if (data.id !== receipt.id || !statuses.has(data.status)) throw new BadGatewayException('Resposta de status inválida do AbacatePay.');
    return { id: receipt.id, status: data.status, devMode: true };
  }

  async simulate(organizationId: string, token: string) {
    const key = this.key();
    const receipt = this.receipt(key, token, organizationId);
    const current = await this.check(organizationId, token);
    if (current.status !== 'PENDING') return current;
    const data = await this.request(key, `/transparents/simulate-payment?id=${encodeURIComponent(receipt.id)}`, {});
    if (data.devMode !== true || data.id !== receipt.id) throw new BadGatewayException('Resposta de simulação inválida do AbacatePay.');
    // Read back: never interpret a successful POST alone as proof of PAID.
    return this.check(organizationId, token);
  }
}
