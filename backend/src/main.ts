// Load .env before any module (and the @Processor decorator) is imported, so
// worker concurrency/rate-limit env vars are populated at decorator-eval time.
import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  // DTOs are validated and stripped of unknown properties everywhere.
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true }),
  );

  // OpenAPI / Swagger — interactive docs at /docs
  const config = new DocumentBuilder()
    .setTitle('Invoice Processing System API')
    .setDescription(
      'Upload invoices (PDF/image), track async processing status in real time, ' +
        'view extracted data, retry failed jobs, and talk to an AI assistant that ' +
        'can both answer questions and take actions.',
    )
    .setVersion('0.1.0')
    .addTag('auth', 'Sign in and receive a JWT')
    .addTag('invoices', 'Upload, list, inspect and retry invoices')
    .addTag('assistant', 'Conversational AI assistant (answer + act)')
    .addTag('health', 'Liveness')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'JWT returned by POST /auth/login',
    })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // Bind to 0.0.0.0 (not localhost) so the app is reachable on PaaS hosts
  // (Railway/Render) — otherwise the platform health check 502s.
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');

  const url = await app.getUrl();
  const logger = new Logger('Bootstrap');
  logger.log(`Application running on ${url}`);
  logger.log(`Swagger docs available at ${url}/docs`);
  if (!process.env.AUTH_PASSWORD) {
    logger.warn('AUTH_PASSWORD is not set — API authentication is DISABLED');
  }
}

void bootstrap();
