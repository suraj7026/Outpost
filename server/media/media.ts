import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { execute } from '../processes/runner.js';
import { Workspace } from '../artifacts/files.js';
import { requireThat } from '../core/contracts.js';
export class MediaTools {
  constructor(private workspace: Workspace, private ffmpeg: string, private ffprobe: string) {}
  async inspect(path: string, signal = new AbortController().signal) {
    const input = this.workspace.path(path); requireThat(statSync(input).size <= 512*1024*1024,'media_too_large');
    const result = await execute([this.ffprobe,'-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',input],this.workspace.root,signal,15000);
    requireThat(result.exitCode === 0 && !result.outputLimitReached,'invalid_media');
    return z.object({ streams: z.array(z.object({ codec_type: z.string(),codec_name: z.string().optional() })),format: z.object({ format_name: z.string(),duration: z.string().optional(),size: z.string().optional() }) }).parse(JSON.parse(result.stdout));
  }
  async audioClip(inputPath: string, outputPath: string, start: number, duration: number, signal = new AbortController().signal) {
    requireThat(Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration > 0 && duration <= 3600,'invalid_clip');
    const input = this.workspace.path(inputPath), output = this.workspace.path(outputPath);
    requireThat(output.endsWith('.wav') && !existsSync(output),'output_conflict');
    const result = await execute([this.ffmpeg,'-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',input,'-ss',String(start),'-t',String(duration),'-vn','-ac','1','-ar','16000',output],this.workspace.root,signal,120000);
    requireThat(result.exitCode === 0 && !result.cancelled && !result.timedOut,'media_conversion_failed');
    const info = await this.inspect(outputPath,signal);
    requireThat(info.streams.some(stream => stream.codec_type === 'audio'),'missing_audio');
    return { output: outputPath,info,source: inputPath };
  }
}
