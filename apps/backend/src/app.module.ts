import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { PlaybackModule } from './playback/playback.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { UploadsModule } from './uploads/uploads.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [ConfigModule, PrismaModule, StorageModule, QueueModule, EventsModule, AuthModule, VideosModule, UploadsModule, PlaybackModule],
  controllers: [HealthController],
})
export class AppModule {}
