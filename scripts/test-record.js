#!/usr/bin/env node
/**
 * 로컬 PoC — 외부 의존성 없이 audio-pipeline + transcript-builder 단위 동작 확인.
 *
 * 시뮬레이션 흐름:
 * 1. ffmpeg로 가짜 stereo 48kHz raw PCM 2개 생성 (사인파, 각 5초)
 * 2. buildSpeakerMp3로 각 화자 MP3 생성
 * 3. buildMixedMp3Parts로 mix MP3 part 생성
 * 4. transcript-builder.mergeAcrossSpeakers / formatTranscript 출력
 *
 * Whisper API + Discord upload는 본 스크립트에서 건드리지 않음 — 실 PoC는 봇 PM2 띄우고 /join.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildSpeakerMp3, buildMixedMp3Parts } from '../src/audio-pipeline.js';
import { mergeAcrossSpeakers, formatTranscript } from '../src/transcript-builder.js';

const TEST_DIR = join('tmp', '_test_record');

function generateFakePcm(outPath, durationSec, freqHz) {
  // ffmpeg로 stereo 48kHz s16le sine wave 생성
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=${freqHz}:duration=${durationSec}:sample_rate=48000`,
    '-ac', '2',
    '-f', 's16le',
    outPath,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('가짜 PCM 생성 실패');
}

async function main() {
  console.log('🧪 test-record 시작');

  // 1) 작업 디렉토리
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // 2) 가짜 PCM 2개 (화자 A: 0~5s, 440Hz / 화자 B: 6~10s, 880Hz)
  const pcmA = join(TEST_DIR, 'speaker_A.pcm');
  const pcmB = join(TEST_DIR, 'speaker_B.pcm');
  console.log('🎵 가짜 PCM 생성');
  generateFakePcm(pcmA, 5, 440);
  generateFakePcm(pcmB, 4, 880);

  // 3) buildSpeakerMp3
  console.log('🎼 화자별 MP3 인코딩');
  const mp3A = join(TEST_DIR, 'speaker_A.mp3');
  const mp3B = join(TEST_DIR, 'speaker_B.mp3');
  await buildSpeakerMp3({ pcmPath: pcmA, outMp3Path: mp3A });
  await buildSpeakerMp3({ pcmPath: pcmB, outMp3Path: mp3B });
  if (!existsSync(mp3A) || !existsSync(mp3B)) {
    throw new Error('화자 MP3 생성 실패');
  }
  console.log(`  ✓ ${mp3A}`);
  console.log(`  ✓ ${mp3B}`);

  // 4) buildMixedMp3Parts (10초이므로 1개 파트)
  console.log('🎚️  mix 30분 분할 (10초 입력이므로 part_1.mp3 1개 예상)');
  const parts = await buildMixedMp3Parts({
    speakerInputs: [
      { pcmPath: pcmA, segments: [{ startMs: 0,    durationMs: 5000 }] },
      { pcmPath: pcmB, segments: [{ startMs: 6000, durationMs: 4000 }] },
    ],
    totalDurationMs: 10000,
    outDir: TEST_DIR,
  });
  console.log(`  → ${parts.length} part(s):`, parts.map((p) => p.path));

  // 5) transcript-builder (Whisper 호출 없이 fake segments로)
  console.log('📝 transcript-builder 시뮬레이션');
  const merged = mergeAcrossSpeakers([
    {
      userId: 'A', displayName: '박지건',
      segments: [{ startMs: 0, durationMs: 5000 }],
      whisperSegments: [{ start: 0, end: 5, text: '안녕하세요 회의 시작합니다' }],
    },
    {
      userId: 'B', displayName: '한장훈',
      segments: [{ startMs: 6000, durationMs: 4000 }],
      whisperSegments: [{ start: 0, end: 4, text: '네 좋습니다' }],
    },
  ]);
  const transcriptText = formatTranscript({
    meeting: {
      guildName: '테스트 서버',
      startedAt: new Date('2026-05-19T03:21:00Z'),
      endedAt: new Date('2026-05-19T03:21:10Z'),
      durationSeconds: 10,
    },
    speakers: [{ displayName: '박지건' }, { displayName: '한장훈' }],
    merged,
    partBoundariesSec: [],
  });
  const transcriptPath = join(TEST_DIR, 'transcript.txt');
  writeFileSync(transcriptPath, transcriptText, 'utf8');
  console.log(`  ✓ ${transcriptPath}`);

  console.log('\n=== transcript 미리보기 ===');
  console.log(transcriptText);
  console.log('=== end ===\n');

  console.log(`✅ test-record 완료. 결과물은 ${TEST_DIR}/ 아래에 있습니다.`);
  console.log('   (실 Whisper + Discord upload는 봇 PM2 + /join PoC에서 검증)');
}

main().catch((err) => {
  console.error('❌ test-record 실패:', err);
  process.exit(1);
});
