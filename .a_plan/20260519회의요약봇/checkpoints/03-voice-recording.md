# 03 — 음성 캡처 (recorder)

> SPEC §1, §2.2, §2.5, §3 / ADR-2 (EndBehaviorType.AfterSilence 내장)

## 목표

`/join` 핸들러에서 voice channel에 연결한 뒤 `@discordjs/voice` receiver로 화자별 Opus 스트림을 받아 16kHz mono PCM으로 디코드하여 `tmp/<meeting_id>/speaker_<userId>.pcm`에 append하고, 각 발화의 `(startMs, durationMs)` segments 메타를 메모리에 누적한다. 동시에 음성 채널 인원=0 30초 지속 시 자동 leave 트리거.

## 작업

### 1. `src/recorder.js` — 핵심 API

```js
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { createWriteStream, mkdirSync } from 'fs';
import { join as pjoin } from 'path';

const TMP_ROOT = 'tmp';
const SILENCE_MS = Number(process.env.END_BEHAVIOR_SILENCE_MS || 1000);

export async function startRecording(session, voiceChannel) {
  mkdirSync(pjoin(TMP_ROOT, String(session.meetingId)), { recursive: true });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,    // 받으려면 false
    selfMute: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  session.voiceConnection = connection;
  session.receiver = connection.receiver;

  // 화자가 말하기 시작하면 subscribe
  connection.receiver.speaking.on('start', (userId) => {
    onSpeakingStart(session, voiceChannel.guild, userId);
  });

  // 연결 끊김 복구
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // 재연결 진행 중
    } catch {
      // 복구 실패 → 강제 종료
      session.forcedDisconnect = true;
      // bot.js의 finalizeMeeting() 호출 트리거
    }
  });
}
```

### 2. 화자별 subscribe + PCM 저장

```js
function onSpeakingStart(session, guild, userId) {
  // 봇 발화 무시
  const member = guild.members.cache.get(userId);
  if (!member || member.user.bot) return;

  // 화자 segments 컨테이너 lazy init
  if (!session.speakerSegments.has(userId)) {
    session.speakerSegments.set(userId, {
      displayName: member.nickname || member.user.globalName || member.user.username,
      segments: [],
      pcmPath: pjoin(TMP_ROOT, String(session.meetingId), `speaker_${userId}.pcm`),
    });
  }
  const sp = session.speakerSegments.get(userId);

  // 침묵 1초 후 stream end
  const opusStream = session.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });

  // Opus → PCM (16kHz mono)
  // Discord native: 48kHz 16-bit stereo. 16kHz mono로 다운샘플은 OpusDecoder 옵션이 아니라
  // OpusDecoder 후 prism.FFmpeg로 변환, 또는 OpusDecoder로 48k stereo 받은 후 audio-pipeline에서 다운샘플
  // → 단순함을 위해 48k stereo PCM 그대로 저장하고 audio-pipeline에서 ffmpeg로 16k mono 변환 (04 체크포인트)
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  const startMs = Date.now() - new Date(session.startedAt).getTime();
  let bytesWritten = 0;

  const pcmWriteStream = createWriteStream(sp.pcmPath, { flags: 'a' });

  opusStream.pipe(decoder).on('data', (chunk) => {
    pcmWriteStream.write(chunk);
    bytesWritten += chunk.length;
  });

  opusStream.on('end', () => {
    pcmWriteStream.end();
    // 48kHz stereo 16-bit = 192,000 bytes/sec
    const durationMs = Math.round((bytesWritten / 192000) * 1000);
    sp.segments.push({ startMs, durationMs });
  });
}
```

### 3. 자동 leave (음성 채널 인원 0명 시)

`bot.js`에 `voiceStateUpdate` 리스너 추가:

```js
const AUTO_LEAVE_SEC = Number(process.env.AUTO_LEAVE_EMPTY_SECONDS || 30);

client.on('voiceStateUpdate', (oldState, newState) => {
  const session = sessions.get(newState.guild.id);
  if (!session) return;

  const channel = newState.guild.channels.cache.get(session.voiceChannelId);
  if (!channel) return;

  // 봇 외 인원 수
  const nonBotCount = channel.members.filter((m) => !m.user.bot).size;

  if (nonBotCount === 0) {
    if (session.autoLeaveTimer) return;   // 이미 카운트다운 중
    session.autoLeaveTimer = setTimeout(async () => {
      console.log(`⏰ 음성 채널 비어있음 → 자동 /leave (meeting ${session.meetingId})`);
      // finalize.js의 orchestrator 호출 (06 체크포인트에서 정의)
      try {
        await finalizeMeeting(client, session, 'auto-empty-channel');
      } catch (err) {
        console.error('자동 finalize 실패:', err);
      }
      sessions.delete(newState.guild.id);
    }, AUTO_LEAVE_SEC * 1000);
  } else {
    if (session.autoLeaveTimer) {
      clearTimeout(session.autoLeaveTimer);
      session.autoLeaveTimer = null;
    }
  }
});
```

### 4. `stopRecording(session)` API

```js
export async function stopRecording(session) {
  if (session.autoLeaveTimer) clearTimeout(session.autoLeaveTimer);

  // receiver subscribe들이 모두 end되도록 잠시 대기 (마지막 발화 정리)
  await new Promise((r) => setTimeout(r, SILENCE_MS + 500));

  try {
    session.voiceConnection?.destroy();
  } catch {}
  session.voiceConnection = null;
}
```

### 5. `bot.js`의 `/join` / `/leave` 통합

- `/join`에서 DB INSERT 후 `await startRecording(session, voiceChannel)`
- `/leave`에서 `await stopRecording(session)` → 04~06 체크포인트의 finalize 파이프라인 호출

### 6. 봇 부팅 시 stale tmp/ 청소

```js
// bot.js 부팅부
import { rmSync, readdirSync, statSync } from 'fs';
try {
  for (const dir of readdirSync('tmp')) {
    const full = `tmp/${dir}`;
    const age = Date.now() - statSync(full).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) rmSync(full, { recursive: true, force: true });
  }
} catch {}
```

## 검수 기준

- [ ] `/join` 후 음성 채널에서 1분간 1~2명 발화
- [ ] `tmp/<meeting_id>/speaker_<userId>.pcm` 파일 생성 + 0 byte 아님
- [ ] `console.log(session.speakerSegments)` 시 화자별 segments 배열에 `{startMs, durationMs}` 누적
- [ ] 모든 사람 음성 채널 나간 후 30초 지나면 자동 leave 로그 + 봇 disconnect
- [ ] `/leave` 후 voice connection destroy + tmp/ 파일은 일단 남아있음 (04~06이 처리)
- [ ] 봇이 본인 voice를 무시함 (`user.bot` 가드 동작)

## 알려진 제약

- 48kHz stereo로 저장 → 1시간 회의 시 화자 1인 ~700MB raw PCM. 디스크 여유 필요. 16kHz mono 변환은 audio-pipeline(04)에서.
- 메모리 누수 방지: opusStream이 end 안 되면 무한 누적. EndBehaviorType.AfterSilence가 보장하지만, 봇 네트워크 끊김 시 leftover 가능성 → stopRecording에서 강제 정리.
- voice receive는 Discord 비공식 API. discord.js/voice 라이브러리가 처리하지만 향후 깨질 가능성 잔존.

## 다음 체크포인트

→ [04-audio-pipeline](./04-audio-pipeline.md)
