import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [ConfigModule, PrismaModule, StorageModule, AuthModule, VideosModule],
  controllers: [HealthController],
})
export class AppModule {}
