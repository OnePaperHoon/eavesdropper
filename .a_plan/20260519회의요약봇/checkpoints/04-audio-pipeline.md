# 04 — 오디오 파이프라인 (ffmpeg)

> SPEC §2.6 / ADR-4 (ffmpeg spawn + prism-media 조합)

## 목표

03 체크포인트가 만든 화자별 48kHz stereo raw PCM 파일과 segments 메타(`[{startMs, durationMs}]`)를 입력으로:
1. **화자별** 32kbps mono MP3 (Whisper용) — 발화 사이 무음 padding 삽입
2. **mix** 32kbps mono MP3 (보관용) → 30분 단위로 분할된 `part_N.mp3` 생성

## 작업

### 1. `src/audio-pipeline.js` — ffmpeg spawn wrapper

```js
import { spawn } from 'child_process';
import { writeFileSync, createWriteStream, existsSync, statSync } from 'fs';
import { join as pjoin } from 'path';
import { Buffer } from 'buffer';

const PART_MINUTES = Number(process.env.MP3_PART_DURATION_MINUTES || 30);
const BITRATE = Number(process.env.MP3_BITRATE_KBPS || 32);

function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 실패 (exit ${code}): ${stderr}`));
    });
  });
}
```

### 2. 화자별 PCM → 시간축 정합 MP3 (Whisper 입력용)

핵심 트릭: PCM 파일은 발화 구간만 들어있으므로 segments 사이에 무음을 채워 회의 시작 기준 절대 시간축을 복원해야 transcript timeline이 정확해진다.

```js
/**
 * speaker raw PCM (48kHz stereo)을 회의 전체 길이의 16kHz mono MP3로 변환.
 * 발화 사이 무음 padding 삽입. Whisper segment timestamps가 회의 시작 기준이 되도록.
 */
export async function buildSpeakerMp3({
  pcmPath, segments, totalDurationMs, outMp3Path,
}) {
  // 전략: ffmpeg에 1) 무음 input 1개 (총 길이) 2) speaker PCM input
  //       → adelay 필터로 각 segment를 정확한 timestamp에 배치 → amix
  // 단순화: ffmpeg concat protocol로 [silence_until_seg1] + [seg1] + [silence] + [seg2] + ...
  //         으로 만든 단일 mono WAV → MP3
  //
  // 가장 확실한 패턴: stdin으로 raw silent PCM bytes를 ffmpeg에 흘려보내며 segment timing에 맞춰 read.
  // 구현 부담 줄이려면 ffmpeg의 'adelay' 필터 사용:
  //   ffmpeg -f s16le -ar 48000 -ac 2 -i speaker.pcm \
  //     -filter_complex "[0:a]aformat=channel_layouts=mono,aresample=16000,adelay=<startMs>:all=1[a]" \
  //     -map "[a]" -c:a libmp3lame -b:a 32k out.mp3
  //
  // 단 PCM 파일에는 여러 segments가 concat되어 있으므로 adelay 한 번으로는 안 됨.
  // → segments마다 별도 input + adelay → amix
  //
  // segments 위치별로 PCM 파일을 byte offset으로 잘라서 N개의 input으로 ffmpeg에 넣기

  // 1) PCM byte offsets 계산: 48kHz stereo 16-bit = 192000 bytes/sec
  const BYTES_PER_SEC = 192000;
  const inputs = [];
  const filters = [];
  let pcmCursor = 0;
  segments.forEach((seg, i) => {
    const startByte = pcmCursor;
    const lengthBytes = Math.round((seg.durationMs / 1000) * BYTES_PER_SEC);
    pcmCursor += lengthBytes;
    inputs.push({ startByte, lengthBytes, delayMs: seg.startMs });
    filters.push(`[${i}:a]aformat=channel_layouts=mono,aresample=16000,adelay=${seg.startMs}|${seg.startMs}[s${i}]`);
  });
  const mixInputs = inputs.map((_, i) => `[s${i}]`).join('');
  filters.push(`${mixInputs}amix=inputs=${inputs.length}:dropout_transition=0[a]`);

  // 2) 각 input을 ffmpeg에 raw PCM 슬라이스로 공급 — 실용적 방법: 사전에 segments별 임시 PCM 파일 생성
  const tmpDir = pjoin('tmp', `__split_${Date.now()}`);
  // (실제 구현에서는 dd로 byte slice 후 input 추가, 또는 single PCM input + asetpts 활용)

  // ── 단순화 대안 ──────────────────────────────────────
  // PCM에 들어있는 byte 순서가 곧 segments 순서이므로:
  //   ffmpeg -f s16le -ar 48000 -ac 2 -i speaker.pcm
  //     -filter_complex "[0:a]aformat=channel_layouts=mono,aresample=16000[a]" -map [a] speaker_concat.wav
  // 으로 일단 화자 발화만 mono 16k로 변환.
  // segments 메타는 누적 startMs를 별도 보관해서 transcript-builder가 사용 (Whisper 결과에 absolute time 부여).
  // ── 이 단순 대안을 1차 구현으로 채택 ─────────────────

  await runFfmpeg([
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    '-i', pcmPath,
    '-filter_complex', '[0:a]aformat=channel_layouts=mono,aresample=16000[a]',
    '-map', '[a]',
    '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
    outMp3Path,
  ], 'speaker mp3');

  // 이 MP3에는 발화 청크가 연속으로 붙어 있다. Whisper segment timestamps는 이 연속 시간 기준.
  // transcript-builder가 segments 메타로 회의 시작 기준 elapsed로 매핑.
}
```

> **중요 단순화**: 위 코드의 1차 구현은 화자 발화를 PCM 순서대로 concat한 단일 MP3를 Whisper에 보낸다. Whisper segment timestamps는 이 "concat 내부 시간" 기준이므로, transcript-builder가 segments 메타(`{startMs, durationMs}`)와 누적 변환해서 회의 시작 기준 elapsed로 재계산한다.
>
> 정확한 시간축 정합 버전(무음 padding 삽입)은 PoC 검증 후 필요 시 진화. 단순 버전이면 Whisper 비용도 줄어듦 (무음 구간 안 보냄).

### 3. 모든 화자 mix → 30분 분할 MP3

```js
/**
 * 모든 화자 PCM을 회의 시작 기준으로 mix하여 분할 MP3 생성.
 * 보관용. transcript와 별개 트랙.
 */
export async function buildMixedMp3Parts({
  speakerInputs,    // [{ pcmPath, segments }]
  totalDurationMs,
  outDir,
}) {
  // 각 화자별로 segments를 회의 시작 기준 절대 timestamp로 정합한 임시 WAV 생성 후 amix.
  // 구현 패턴:
  //   1) 화자마다 회의 전체 길이의 무음 mono 16k WAV 생성
  //   2) segments 위치에 화자 PCM bytes를 overwrite
  //   3) N개 WAV → amix → mp3 → segment 필터로 30분 분할

  // 1차 구현은 더 단순하게:
  //   화자별 PCM에 adelay+aresample 필터 적용하여 회의 시작 기준 정렬된 mono 16k 트랙 N개 생성
  //   → amix → MP3 → segment cut

  const inputArgs = [];
  const filterChunks = [];
  speakerInputs.forEach((sp, idx) => {
    inputArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', sp.pcmPath);
    // 첫 segment startMs 만큼 delay (단순화: 화자 발화 시작 시점에 정렬)
    const firstStartMs = sp.segments[0]?.startMs ?? 0;
    filterChunks.push(
      `[${idx}:a]aformat=channel_layouts=mono,aresample=16000,adelay=${firstStartMs}|${firstStartMs}[a${idx}]`
    );
  });
  const mixIn = speakerInputs.map((_, i) => `[a${i}]`).join('');
  filterChunks.push(`${mixIn}amix=inputs=${speakerInputs.length}:dropout_transition=0,apad=whole_dur=${totalDurationMs}ms[mix]`);

  const mixedPath = pjoin(outDir, '_mixed.mp3');
  await runFfmpeg([
    ...inputArgs,
    '-filter_complex', filterChunks.join(';'),
    '-map', '[mix]',
    '-c:a', 'libmp3lame', '-b:a', `${BITRATE}k`,
    mixedPath,
  ], 'mix');

  // 30분 단위 분할: ffmpeg segment muxer
  const partPattern = pjoin(outDir, 'part_%d.mp3');
  await runFfmpeg([
    '-i', mixedPath,
    '-f', 'segment',
    '-segment_time', String(PART_MINUTES * 60),
    '-reset_timestamps', '1',
    '-c', 'copy',
    partPattern,
  ], 'segment');

  // part_0.mp3, part_1.mp3 ... → part_1.mp3, part_2.mp3로 rename (1-indexed)
  // 그리고 메타 (duration, size) 수집해서 반환
  // ...
}
```

### 4. 단위 테스트용 헬퍼 (scripts/test-record.js에서 호출)

```js
export async function testGenerateSilenceWav(durationMs, outPath) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `anullsrc=cl=mono:r=16000`,
    '-t', String(durationMs / 1000),
    outPath,
  ], 'silence');
}
```

## 검수 기준

- [ ] 03 체크포인트가 만든 PCM 파일 + segments 메타로 `buildSpeakerMp3` 호출 → 화자별 mp3 생성, mediainfo로 32kbps mono 16kHz 확인
- [ ] `buildMixedMp3Parts` 호출 → `part_1.mp3` 생성 (회의가 30분 이내일 경우 단일 파트)
- [ ] 1시간 시뮬레이션 PCM 입력 시 `part_1.mp3`, `part_2.mp3` 두 개 생성
- [ ] 각 part_N.mp3 재생 시 화자들이 동시 mix되어 들림
- [ ] 파일 크기 30분 ≈ 5~8MB (32kbps 모노)

## 알려진 단순화 / 향후 개선

- 1차 구현은 화자별 발화를 단순 concat → Whisper 호출 (정확한 timestamp 복원은 transcript-builder가 segments 메타로 처리)
- 더 정확한 시간축 정합이 필요해지면 adelay 기반 정밀 mix 버전으로 진화
- ffmpeg `apad`/`adelay` 필터는 일부 빌드에서 동작이 다름 — Pi5 ffmpeg는 표준 빌드라 OK이지만 검증 필요

## 다음 체크포인트

→ [05-stt-transcript](./05-stt-transcript.md)
