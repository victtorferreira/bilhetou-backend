import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { allowedOrigins } from './security/origins';
import { configureHttpSecurity } from './security/http-security';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  configureHttpSecurity(app);
  app.enableCors({ origin: allowedOrigins(), methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type'], credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
bootstrap();
