import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.CORS_ORIGINS.split(','), credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  console.log(`backend listening on :${config.PORT}`);
}
bootstrap();
