import { spawn } from 'child_process';
import { statSync, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join as pjoin } from 'path';

const PART_MINUTES = Number(process.env.MP3_PART_DURATION_MINUTES || 30);
const BITRATE = Number(process.env.MP3_BITRATE_KBPS || 32);

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
 * 화자의 발화별 raw PCM(48kHz stereo s16le)들을 ffmpeg concat filter로 부드럽게 이어붙여
 * 16kHz mono raw PCM 단일 파일로 만든다.
 *
 * 이 mono PCM이 (1) Whisper MP3 변환과 (2) mix MP3 양쪽에서 재사용된다 — 인코딩 1회만.
 *
 * @param {object} opts
 * @param {Array<{startMs:number, durationMs:number, pcmPath:string}>} opts.segments
 * @param {string} opts.outMonoPcmPath  출력 mono 16kHz s16le PCM
 */
export async function buildSpeakerMonoPcm({ segments, outMonoPcmPath }) {
  if (!segments?.length) throw new Error('buildSpeakerMonoPcm: segments 비어있음');

  // 유효한 segment만 (파일 존재 + size > 0)
  const valid = segments.filter(
    (s) => existsSync(s.pcmPath) && statSync(s.pcmPath).size > 0,
  );
  if (valid.length === 0) throw new Error('buildSpeakerMonoPcm: 유효 segment 0');

  const inputArgs = [];
  valid.forEach((seg) => {
    inputArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', seg.pcmPath);
  });
  const filterIn = valid.map((_, i) => `[${i}:a]`).join('');
  const filter =
    `${filterIn}concat=n=${valid.length}:v=0:a=1[c];` +
    `[c]aformat=channel_layouts=mono,aresample=16000[out]`;

  await runFfmpeg([
    ...inputArgs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-f', 's16le',
    '-ar', '16000',
    '-ac', '1',
    outMonoPcmPath,
  ], 'speaker mono pcm concat');
}

/**
 * 화자별 mono raw PCM → Whisper 입력용 32kbps mono MP3.
 * 입력이 이미 16kHz mono라 별도 resample 없이 인코딩만.
 */
export async function buildSpeakerMp3FromMonoPcm({ monoPcmPath, outMp3Path }) {
  if (!existsSync(monoPcmPath) || statSync(monoPcmPath).size === 0) {
    throw new Error(`buildSpeakerMp3FromMonoPcm: 입력 PCM 없음 ${monoPcmPath}`);
  }
  await runFfmpeg([
    '-f', 's16le', '-ar', '16000', '-ac', '1',
    '-i', monoPcmPath,
    '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
    outMp3Path,
  ], 'speaker mp3');
}

/**
 * 화자별 mono PCM 트랙들을 첫 발화 시점만큼 adelay → amix → 30분 분할 MP3.
 *
 * 주의: 현재 1차 구현은 화자 트랙 내부에서 발화 사이 무음을 padding하지 않으므로
 * mix MP3의 후속 발화 시점은 실제 회의보다 빠르게 등장할 수 있다 (시간 압축).
 * transcript의 timeline은 별도 segments 메타로 정확히 매핑되므로 영향 없음.
 *
 * @param {object} opts
 * @param {Array<{monoPcmPath:string, firstStartMs:number}>} opts.speakerInputs
 * @param {number} opts.totalDurationMs
 * @param {string} opts.outDir
 * @returns {Promise<Array<{path:string, partIndex:number, durationSec:number}>>}
 */
export async function buildMixedMp3Parts({ speakerInputs, totalDurationMs, outDir }) {
  const valid = speakerInputs.filter(
    (sp) => sp.monoPcmPath && existsSync(sp.monoPcmPath) && statSync(sp.monoPcmPath).size > 0,
  );
  if (valid.length === 0) return [];

  const totalSec = Math.max(1, Math.ceil(totalDurationMs / 1000));

  // 화자별 16kHz mono input + 첫 발화 startMs로 adelay → amix
  const inputArgs = [];
  const filterChunks = [];
  valid.forEach((sp, idx) => {
    inputArgs.push('-f', 's16le', '-ar', '16000', '-ac', '1', '-i', sp.monoPcmPath);
    const delay = Math.max(0, Math.floor(sp.firstStartMs || 0));
    filterChunks.push(`[${idx}:a]adelay=${delay}|${delay}[a${idx}]`);
  });
  const mixIn = valid.map((_, i) => `[a${i}]`).join('');
  filterChunks.push(
    `${mixIn}amix=inputs=${valid.length}:normalize=0:dropout_transition=0,` +
    `apad,atrim=duration=${totalSec}[mix]`,
  );

  const mixedPath = pjoin(outDir, '_mixed.mp3');
  await runFfmpeg([
    ...inputArgs,
    '-filter_complex', filterChunks.join(';'),
    '-map', '[mix]',
    '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
    mixedPath,
  ], 'mix');

  // 30분 단위 분할
  await runFfmpeg([
    '-i', mixedPath,
    '-f', 'segment',
    '-segment_time', String(PART_MINUTES * 60),
    '-reset_timestamps', '1',
    '-c', 'copy',
    pjoin(outDir, 'part_%d.mp3'),
  ], 'segment');

  // 0-indexed → 1-indexed
  const generated = readdirSync(outDir)
    .filter((f) => /^part_\d+\.mp3$/.test(f))
    .sort((a, b) => {
      const ai = Number(a.match(/part_(\d+)\.mp3/)[1]);
      const bi = Number(b.match(/part_(\d+)\.mp3/)[1]);
      return ai - bi;
    });

  for (let i = generated.length - 1; i >= 0; i--) {
    const oldPath = pjoin(outDir, generated[i]);
    const newPath = pjoin(outDir, `part_${i + 1}.mp3`);
    if (oldPath !== newPath) {
      try { renameSync(oldPath, newPath); } catch {}
    }
  }

  try { unlinkSync(mixedPath); } catch {}

  const parts = [];
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
