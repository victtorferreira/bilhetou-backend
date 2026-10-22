import { CanActivate, ExecutionContext, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';

export function demoOrigins() {
  return [process.env.FRONTEND_ORIGIN || 'http://localhost:5173', 'http://127.0.0.1:5173'];
}

// This is NOT administrator authentication. It only permits an explicitly enabled
// local technical demo. Replace with real authentication/authorization for deployment.
@Injectable()
export class LocalDemoGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_LOCAL_DEMO_TICKET_CREATION !== 'true') throw new NotFoundException();
    const request = context.switchToHttp().getRequest<{ method: string; socket: { remoteAddress?: string }; headers: Record<string, string | undefined> }>();
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) throw new ForbiddenException('Operação disponível somente na demonstração local.');
    if (request.headers.origin && !demoOrigins().includes(request.headers.origin)) throw new ForbiddenException('Origem não permitida.');
    if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) throw new ForbiddenException('Envie JSON.');
    return true;
  }
}
