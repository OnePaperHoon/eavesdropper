import { spawn } from 'child_process';
import { statSync, existsSync, readdirSync, renameSync } from 'fs';
import { join as pjoin } from 'path';

const PART_MINUTES = Number(process.env.MP3_PART_DURATION_MINUTES || 30);
const BITRATE = Number(process.env.MP3_BITRATE_KBPS || 32);

// recorder.js와 동일 — 48kHz stereo 16-bit
const BYTES_PER_SEC_48K_STEREO = 48000 * 2 * 2;

/**
 * ffmpeg spawn wrapper. stderr를 캡처하여 실패 시 메시지 포함.
 */
function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      reject(new Error(`${label} spawn 실패: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 실패 (exit ${code}): ${stderr.trim() || '<no stderr>'}`));
    });
  });
}

/**
 * 화자 raw PCM (48kHz stereo 16-bit, 발화 청크 concat 상태)을
 * Whisper 입력용 16kHz mono MP3로 변환.
 *
 * ADR-1 1차 구현: PCM은 발화 순서대로 concat된 형태 그대로 → mono/16k로 단순 변환만.
 * Whisper segment timestamps는 이 "concat 내부 시간" 기준이며,
 * transcript-builder가 segments 메타로 회의 시작 elapsed로 매핑한다.
 *
 * @param {object} opts
 * @param {string} opts.pcmPath          입력 raw PCM (48kHz stereo s16le)
 * @param {Array<{startMs:number, durationMs:number}>} opts.segments  — 사용처: 매핑 메타 (본 함수는 안 씀)
 * @param {number} opts.totalDurationMs  — 매핑 메타 (본 함수는 안 씀)
 * @param {string} opts.outMp3Path       출력 mono 16kHz MP3
 */
export async function buildSpeakerMp3({ pcmPath, outMp3Path }) {
  if (!existsSync(pcmPath)) {
    throw new Error(`buildSpeakerMp3: 입력 PCM 없음 ${pcmPath}`);
  }
  if (statSync(pcmPath).size === 0) {
    throw new Error(`buildSpeakerMp3: 입력 PCM 0바이트 ${pcmPath}`);
  }
  await runFfmpeg(
    [
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', pcmPath,
      '-filter_complex', '[0:a]aformat=channel_layouts=mono,aresample=16000[a]',
      '-map', '[a]',
      '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
      outMp3Path,
    ],
    'speaker mp3',
  );
}

/**
 * 모든 화자 PCM을 회의 시작 기준으로 mix하여 보관용 MP3 part_N 생성.
 * 각 화자의 첫 발화 시작(startMs)만큼 adelay 후 amix → segment muxer로 30분 분할.
 *
 * @param {object} opts
 * @param {Array<{pcmPath:string, segments:Array<{startMs:number,durationMs:number}>}>} opts.speakerInputs
 * @param {number} opts.totalDurationMs
 * @param {string} opts.outDir
 * @returns {Promise<Array<{path:string, partIndex:number, durationSec:number}>>}
 */
export async function buildMixedMp3Parts({ speakerInputs, totalDurationMs, outDir }) {
  const validInputs = speakerInputs.filter(
    (sp) => existsSync(sp.pcmPath) && statSync(sp.pcmPath).size > 0,
  );
  if (validInputs.length === 0) {
    return [];
  }

  const totalSec = Math.max(1, Math.ceil(totalDurationMs / 1000));

  // 1단계: 화자 트랙들을 회의 시작 기준 절대 시간축에 정렬 + amix → 단일 mixed MP3
  const inputArgs = [];
  const filterChunks = [];
  validInputs.forEach((sp, idx) => {
    inputArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', sp.pcmPath);
    const firstStartMs = sp.segments[0]?.startMs ?? 0;
    filterChunks.push(
      `[${idx}:a]aformat=channel_layouts=mono,aresample=16000,adelay=${firstStartMs}|${firstStartMs}[a${idx}]`,
    );
  });
  const mixIn = validInputs.map((_, i) => `[a${i}]`).join('');
  filterChunks.push(
    `${mixIn}amix=inputs=${validInputs.length}:dropout_transition=0,apad,atrim=duration=${totalSec}[mix]`,
  );

  const mixedPath = pjoin(outDir, '_mixed.mp3');
  await runFfmpeg(
    [
      ...inputArgs,
      '-filter_complex', filterChunks.join(';'),
      '-map', '[mix]',
      '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
      mixedPath,
    ],
    'mix',
  );

  // 2단계: 30분 단위 분할 → part_%d.mp3 (0-indexed → 1-indexed로 rename)
  await runFfmpeg(
    [
      '-i', mixedPath,
      '-f', 'segment',
      '-segment_time', String(PART_MINUTES * 60),
      '-reset_timestamps', '1',
      '-c', 'copy',
      pjoin(outDir, 'part_%d.mp3'),
    ],
    'segment',
  );

  // 0-indexed → 1-indexed
  const generated = readdirSync(outDir)
    .filter((f) => /^part_\d+\.mp3$/.test(f))
    .sort((a, b) => {
      const ai = Number(a.match(/part_(\d+)\.mp3/)[1]);
      const bi = Number(b.match(/part_(\d+)\.mp3/)[1]);
      return ai - bi;
    });

  const parts = [];
  for (let i = generated.length - 1; i >= 0; i--) {
    const oldPath = pjoin(outDir, generated[i]);
    const newPath = pjoin(outDir, `part_${i + 1}.mp3`);
    if (oldPath !== newPath) {
      // rename 충돌 방지: 마지막부터 거꾸로 처리
      try { renameSync(oldPath, newPath); } catch {}
    }
  }
  // 메타 수집
  for (let i = 1; i <= generated.length; i++) {
    const p = pjoin(outDir, `part_${i}.mp3`);
    if (!existsSync(p)) continue;
    const isLast = i === generated.length;
    const durationSec = isLast
      ? totalSec - PART_MINUTES * 60 * (generated.length - 1)
      : PART_MINUTES * 60;
    parts.push({
      path: p,
      partIndex: i,
      durationSec: Math.max(1, durationSec),
    });
  }

  return parts;
}
