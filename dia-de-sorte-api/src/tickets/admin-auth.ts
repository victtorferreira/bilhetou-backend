import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { allowedOrigins } from '../security/origins';

export interface AdminRequest { headers: Record<string, string | undefined>; admin: { organizationId: string; actor: string } }
// Nest can instantiate a guard separately from the controller's injected service.
// Both must use the same session store within this API process.
@Injectable()
export class AdminSessionStore {
  readonly sessions = new Map<string, { organizationId: string; actor: string; expires: number }>();
  readonly attempts = new Map<string, { count: number; expires: number }>();
}
@Injectable()
export class AdminAuth implements CanActivate {
  constructor(private readonly store: AdminSessionStore) {}
  login(secret: string, remoteAddress: string) {
    const now = Date.now();
    for (const [key, value] of this.store.attempts) if (value.expires <= now) this.store.attempts.delete(key);
    const attempts = this.store.attempts.get(remoteAddress) ?? { count: 0, expires: now + 15 * 60_000 };
    if (++attempts.count > 10 || this.store.attempts.size > 10000) throw new UnauthorizedException('Muitas tentativas. Aguarde 15 minutos.');
    this.store.attempts.set(remoteAddress, attempts);
    const expected = process.env.ADMIN_ACCESS_KEY;
    const organizationId = process.env.ADMIN_ORGANIZATION_ID;
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!expected || expected.length < 32 || !organizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId) || !timingSafeEqual(hash(secret), hash(expected))) throw new UnauthorizedException('Credencial inválida ou administração não configurada.');
    for (const [key, value] of this.store.sessions) if (value.expires <= now) this.store.sessions.delete(key);
    if (this.store.sessions.size >= 1000) throw new UnauthorizedException('Limite de sessões. Aguarde a expiração.');
    const token = randomBytes(32).toString('hex');
    this.store.sessions.set(token, { organizationId, actor: process.env.ADMIN_ACTOR || 'configured-admin', expires: now + 8 * 3600_000 });
    this.store.attempts.delete(remoteAddress);
    return token;
  }
  cookie(token: string, logout = false) {
    return `bilhetou_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${logout ? 0 : 28800}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  }
  private token(request: AdminRequest) { return request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('bilhetou_admin='))?.slice('bilhetou_admin='.length); }
  logout(request: AdminRequest) { const token = this.token(request); if (token) this.store.sessions.delete(token); }
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getResponse?.()?.setHeader?.('Cache-Control', 'private, no-store');
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (request.headers.origin && !allowedOrigins().includes(request.headers.origin)) throw new ForbiddenException('Origem não permitida.');
    const session = this.store.sessions.get(this.token(request) || '');
    if (!session || session.expires <= Date.now()) throw new UnauthorizedException('Entre com a credencial administrativa.');
    request.admin = { organizationId: session.organizationId, actor: session.actor };
    return true;
  }
}
