import { Global, Module } from '@nestjs/common';
import { VideoQueueService } from './video-queue.service';

@Global()
@Module({
  providers: [VideoQueueService],
  exports: [VideoQueueService],
})
export class QueueModule {}
