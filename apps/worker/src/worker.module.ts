import { Module } from '@nestjs/common';
import { VideoProcessor } from './video.processor';

@Module({
  providers: [VideoProcessor],
})
export class WorkerModule {}
