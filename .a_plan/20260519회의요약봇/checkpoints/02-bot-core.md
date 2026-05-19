# 02 — 봇 코어 (명령 + 가드)

> SPEC §1, §2.3, §2.4, §2.9, §7 / threads-make `src/discord-bot.js` 헤더 패턴

## 목표

Discord 봇이 부팅되고 `/join`, `/leave`, `/status` 슬래시 명령에 응답하며, 권한 가드(호출자 음성채널 참여 필수)와 단일 회의 세션 가드(전역 Map<guildId, MeetingSession>)가 동작한다. 이 단계에서는 **녹음·STT 없이** 봇 입장/퇴장 + 공지 Embed까지만.

## 작업

### 1. `src/discord-register.js`

```js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('당신이 참여 중인 음성 채널에서 회의 녹음을 시작합니다'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('현재 회의 녹음을 종료하고 트랜스크립트를 게시합니다'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('현재 진행 중인 회의가 있는지 확인합니다'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(
    process.env.DISCORD_CLIENT_ID,
    process.env.DISCORD_GUILD_ID
  ),
  { body: commands }
);

console.log('✅ 슬래시 명령 등록 완료');
```

### 2. `src/bot.js`

골격 (실제 STT/recorder 호출은 03 체크포인트에서 주입):

```js
import 'dotenv/config';
import {
  Client, GatewayIntentBits, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { query } from './db.js';

const ALERTS_CHANNEL = process.env.DISCORD_ALERTS_CHANNEL_ID;
const TRANSCRIPT_CHANNEL = process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,   // voice channel 추적 필수
    GatewayIntentBits.GuildMessages,
  ],
});

// 전역 세션: 단일 회의만 — guildId → MeetingSession
const sessions = new Map();

async function sendAlert(msg) { /* threads-make 패턴 */ }

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  sendAlert(`⚠️ 봇 미처리 예외: ${err?.message || err}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });   // 3초 룰

  try {
    if (interaction.commandName === 'join')   return handleJoin(interaction);
    if (interaction.commandName === 'leave')  return handleLeave(interaction);
    if (interaction.commandName === 'status') return handleStatus(interaction);
  } catch (err) {
    console.error('명령 처리 오류:', err);
    await interaction.editReply(`❌ 오류: ${err.message}`);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
```

### 3. `/join` 핸들러

```js
async function handleJoin(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;

  // 권한 가드: 호출자가 음성 채널에 있어야 함
  if (!voiceChannel) {
    return interaction.editReply('❌ 먼저 음성 채널에 입장한 후 /join을 호출해주세요.');
  }

  // 단일 세션 가드
  const existing = sessions.get(interaction.guildId);
  if (existing) {
    return interaction.editReply(
      `❌ 이미 #${existing.voiceChannelName}에서 녹음 중입니다. ` +
      `종료하려면 해당 채널에서 /leave를 호출해주세요.`
    );
  }

  // DB INSERT (status='recording')
  const { rows } = await query(
    `INSERT INTO meetings (guild_id, guild_name, voice_channel_id, voice_channel_name,
       invoked_by_user_id, invoked_by_name)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, started_at`,
    [interaction.guildId, interaction.guild.name, voiceChannel.id, voiceChannel.name,
     interaction.user.id, member.displayName]
  );
  const meetingId = rows[0].id;

  // 세션 등록 (실제 voice connection은 03 체크포인트에서 startRecording() 호출로)
  sessions.set(interaction.guildId, {
    meetingId,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    startedAt: rows[0].started_at,
    invokedByUserId: interaction.user.id,
    invokedByName: member.displayName,
    // 03 체크포인트가 채울 필드들:
    voiceConnection: null,
    receiver: null,
    speakerSegments: new Map(),
    autoLeaveTimer: null,
  });

  // TODO(03): startRecording(session, voiceChannel)

  // 입장 공지 Embed — 음성 채널 텍스트 채팅
  const embed = new EmbedBuilder()
    .setTitle('🎙️ 회의 녹음 시작')
    .setDescription(
      `<@${interaction.user.id}>님이 회의 녹음을 시작했습니다.\n` +
      `종료하려면 \`/leave\`를 호출하세요.\n` +
      `트랜스크립트는 <#${TRANSCRIPT_CHANNEL}>에 쓰레드로 게시됩니다.`
    )
    .setColor(0x5865F2)
    .setTimestamp();
  await voiceChannel.send({ embeds: [embed] });

  await interaction.editReply(`✅ #${voiceChannel.name}에서 녹음을 시작했습니다.`);
}
```

### 4. `/leave` 핸들러

```js
async function handleLeave(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.editReply('❌ 현재 진행 중인 회의가 없습니다.');
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  // 권한: /leave는 봇이 있는 음성 채널의 참여자 누구나
  if (!voiceChannel || voiceChannel.id !== session.voiceChannelId) {
    return interaction.editReply(
      `❌ \`/leave\`는 봇이 있는 음성 채널(#${session.voiceChannelName}) 참여자만 호출할 수 있습니다.`
    );
  }

  await interaction.editReply('🔄 회의 종료 처리 중... transcript와 요약이 곧 게시됩니다.');

  // orchestration은 src/finalize.js에 위임 — 06 체크포인트에서 정의됨
  // 본 02 체크포인트 단계에서는 import { finalizeMeeting } from './finalize.js' 자리만 두고,
  // 임시 stub: voiceConnection 있으면 destroy + 세션 제거만
  try {
    if (session.voiceConnection) session.voiceConnection.destroy();
  } catch {}
  sessions.delete(interaction.guildId);

  // 06 체크포인트 통합 후: await finalizeMeeting(client, session, 'manual-leave');
}
```

### 5. `/status` 핸들러

```js
async function handleStatus(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.editReply('현재 진행 중인 회의 없음.');
  }
  const elapsed = Math.floor((Date.now() - new Date(session.startedAt)) / 1000);
  return interaction.editReply(
    `🎙️ 녹음 중: #${session.voiceChannelName} · 시작자: ${session.invokedByName} · 경과 ${elapsed}초`
  );
}
```

### 6. 슬래시 명령 등록 실행

```bash
npm run discord:register-commands
```

## 검수 기준

- [ ] `npm start` 실행 시 봇이 Discord에 online 표시
- [ ] 음성 채널 미참여 상태에서 `/join` → 거절 메시지
- [ ] 음성 채널 참여 후 `/join` → 봇이 음성 채널에 들어옴 + "🎙️ 회의 녹음 시작" Embed가 음성 채널 텍스트에 표시
- [ ] DB `meetings` 테이블에 status='recording' row 1건 생성 확인
- [ ] 같은 길드에서 다시 `/join` → "이미 녹음 중" 거절
- [ ] 다른 음성 채널의 사용자가 `/leave` 호출 → 거절
- [ ] 봇이 있는 음성 채널 참여자가 `/leave` → 봇 음성 채널에서 빠짐, 세션 제거
- [ ] `/status` 응답 정확

> 이 단계에서는 PCM 캡처·STT 없음. `/leave` 시 단순히 voice channel disconnect (03 체크포인트에서 voiceConnection 추가 후 destroy 호출 패턴으로 진화).

## 다음 체크포인트

→ [03-voice-recording](./03-voice-recording.md)
