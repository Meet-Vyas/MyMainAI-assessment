import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminVideosController } from './admin-videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminVideosController],
  providers: [VideosService],
})
export class VideosModule {}
