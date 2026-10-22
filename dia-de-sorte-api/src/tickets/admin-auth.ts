import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { allowedOrigins } from '../security/origins';

export interface AdminRequest { headers: Record<string, string | undefined>; admin: { organizationId: string; actor: string } }
@Injectable()
export class AdminAuth implements CanActivate {
  private readonly sessions = new Map<string, { organizationId: string; actor: string; expires: number }>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  login(secret: string, remoteAddress: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    const attempts = this.attempts.get(remoteAddress) ?? { count: 0, expires: now + 15 * 60_000 };
    if (++attempts.count > 10 || this.attempts.size > 10000) throw new UnauthorizedException('Muitas tentativas. Aguarde 15 minutos.');
    this.attempts.set(remoteAddress, attempts);
    const expected = process.env.ADMIN_ACCESS_KEY;
    const organizationId = process.env.ADMIN_ORGANIZATION_ID;
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!expected || expected.length < 32 || !organizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId) || !timingSafeEqual(hash(secret), hash(expected))) throw new UnauthorizedException('Credencial inválida ou administração não configurada.');
    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) throw new UnauthorizedException('Limite de sessões. Aguarde a expiração.');
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { organizationId, actor: process.env.ADMIN_ACTOR || 'configured-admin', expires: now + 8 * 3600_000 });
    this.attempts.delete(remoteAddress);
    return token;
  }
  cookie(token: string, logout = false) {
    return `bilhetou_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${logout ? 0 : 28800}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  }
  private token(request: AdminRequest) { return request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('bilhetou_admin='))?.slice(15); }
  logout(request: AdminRequest) { const token = this.token(request); if (token) this.sessions.delete(token); }
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (request.headers.origin && !allowedOrigins().includes(request.headers.origin)) throw new ForbiddenException('Origem não permitida.');
    const session = this.sessions.get(this.token(request) || '');
    if (!session || session.expires <= Date.now()) throw new UnauthorizedException('Entre com a credencial administrativa.');
    request.admin = { organizationId: session.organizationId, actor: session.actor };
    return true;
  }
}
