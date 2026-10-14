import { Module } from '@nestjs/common';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';

@Module({
  controllers: [PlaybackController],
  providers: [PlaybackService],
})
export class PlaybackModule {}
