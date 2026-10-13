import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VideosModule } from '../videos/videos.module';
import { UploadSweeperService } from './upload-sweeper.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [AuthModule, VideosModule],
  controllers: [UploadsController],
  providers: [UploadsService, UploadSweeperService],
})
export class UploadsModule {}
