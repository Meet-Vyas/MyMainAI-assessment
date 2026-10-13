import { Module } from '@nestjs/common';
import { loadConfig, WORKER_CONFIG } from './config';
import { EventsService } from './events.service';
import { VideoRepository } from './processing/video.repository';
import { ReconcilerService } from './reconciler.service';
import { StorageService } from './storage.service';
import { VideoProcessor } from './video.processor';

@Module({
  providers: [
    { provide: WORKER_CONFIG, useFactory: () => loadConfig() },
    VideoRepository,
    StorageService,
    EventsService,
    VideoProcessor,
    ReconcilerService,
  ],
})
export class WorkerModule {}
