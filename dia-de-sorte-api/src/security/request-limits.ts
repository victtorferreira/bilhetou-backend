import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RequestLimits implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async consume(scope: string, identity: string, maximum: number, windowMs: number) {
    const key = createHash('sha256').update(`${scope}\0${identity}`).digest('hex');
    // Atomic across processes/replicas; no raw phone, cookie or IP is stored.
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RequestLimit" ("key", "count", "expiresAt")
      VALUES (${key}, 1, NOW() + ${windowMs} * INTERVAL '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RequestLimit"."expiresAt" <= NOW() THEN 1 ELSE LEAST("RequestLimit"."count" + 1, ${maximum + 1}) END,
        "expiresAt" = CASE WHEN "RequestLimit"."expiresAt" <= NOW() THEN NOW() + ${windowMs} * INTERVAL '1 millisecond' ELSE "RequestLimit"."expiresAt" END
      RETURNING "count"`;
    if (!rows.length || rows[0].count > maximum) throw new HttpException('Muitas solicitações. Aguarde antes de tentar novamente.', 429);
  }
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ method: string; path: string; ip?: string; socket: { remoteAddress?: string }; headers: Record<string, string | undefined> }>();
    // Express accepts case variations and trailing slashes for these routes.
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    // Webhooks are authenticated cryptographically. Never block valid administrator
    // credentials because unrelated people share the ingress address.
    if (path === '/api/admin' || path.startsWith('/api/admin/') || path === '/api/health' || path === '/api/payments/zettpay/webhook') return true;
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    await this.consume('public', address, 600, 60_000);
    if (req.method !== 'POST') return true;
    const session = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('bilhetou_participant=')) || address;
    if (/\/(participant|demo)\/session$/.test(path)) {
      await this.consume('registrations-global', 'all', 1000, 3_600_000);
      await this.consume('registration', address, 10, 15 * 60_000);
    } else if (/\/payment\/check$/.test(path)) {
      await this.consume('payment-check', session, 20, 60_000);
    } else {
      await this.consume('mutations', session, 60, 60_000);
      if (/\/orders$|\/payment$/.test(path)) {
        await this.consume('checkout-address', address, 30, 15 * 60_000);
        await this.consume('checkout-session', session, 10, 15 * 60_000);
      }
    }
    return true;
  }
}
