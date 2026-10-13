import { Global, Module } from '@nestjs/common';
import { VideoEventsService } from './video-events.service';

@Global()
@Module({
  providers: [VideoEventsService],
  exports: [VideoEventsService],
})
export class EventsModule {}
