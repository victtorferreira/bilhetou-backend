import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

export function configureHttpSecurity(app: NestExpressApplication) {
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Exact IPs/CIDRs of controlled ingress only. Never use true or a hop count.
  const proxies = process.env.TRUSTED_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean);
  if (proxies?.some(value => value === 'true' || value === '0.0.0.0/0' || value === '::/0' || !/[.:]/.test(value))) throw new Error('TRUSTED_PROXY_CIDRS deve conter somente IPs/CIDRs dos proxies controlados.');
  app.set('trust proxy', proxies?.length ? proxies : false);
  app.use(helmet());
  app.use((req: { headers: Record<string, string | undefined> }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      res.status(415).json({ message: 'Corpos comprimidos não são aceitos.' }); return;
    }
    next();
  });
  app.useBodyParser('json', { limit: '512kb', inflate: false });
  app.useBodyParser('urlencoded', { limit: '16kb', extended: false, inflate: false });
}
