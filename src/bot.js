import 'dotenv/config';
import {
  Client, GatewayIntentBits, EmbedBuilder, MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel, VoiceConnectionStatus, entersState,
} from '@discordjs/voice';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join as pjoin } from 'path';
import { query } from './db.js';
import { startRecording } from './recorder.js';
import { finalizeMeeting } from './finalize.js';

const ALERTS_CHANNEL = process.env.DISCORD_ALERTS_CHANNEL_ID;
const TRANSCRIPT_CHANNEL = process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;
const AUTO_LEAVE_SEC = Number(process.env.AUTO_LEAVE_EMPTY_SECONDS || 30);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// 전역 세션: 단일 회의만 — guildId → MeetingSession
const sessions = new Map();

// ── 헬퍼 ────────────────────────────────────────────

async function sendAlert(message) {
  if (!ALERTS_CHANNEL) {
    console.warn('[ALERT 미설정]', message);
    return;
  }
  try {
    const channel = await client.channels.fetch(ALERTS_CHANNEL);
    await channel.send(message);
  } catch (err) {
    console.error('알림 전송 실패:', err.message);
  }
}

// ── 진입점 ─────────────────────────────────────────

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  sendAlert(`⚠️ 봇 미처리 예외: ${err?.message || err}`).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  sendAlert(`⚠️ 봇 미처리 예외: ${err?.message || err}`).catch(() => {});
});

// stale tmp 청소 (부팅 시 7일 이전 디렉토리 제거)
function cleanStaleTmp() {
  try {
    if (!existsSync('tmp')) {
      mkdirSync('tmp', { recursive: true });
      return;
    }
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const entry of readdirSync('tmp')) {
      if (entry === '.gitkeep') continue;
      const full = pjoin('tmp', entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch (err) {
    console.warn('stale tmp 청소 실패:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} 준비 완료`);

  cleanStaleTmp();

  // stuck row 청소 — 1시간 이상 in-progress
  try {
    const result = await query(
      `UPDATE meetings
       SET status = 'failed',
           error_message = COALESCE(error_message, 'bot restarted while in progress')
       WHERE status IN ('recording','transcribing','summarizing')
         AND started_at < NOW() - INTERVAL '1 hour'
       RETURNING id`,
    );
    if (result.rowCount > 0) {
      console.log(`🧹 stuck 회의 ${result.rowCount}건 → failed`);
    }
  } catch (err) {
    console.warn('stuck row 청소 실패:', err.message);
  }
});

// ── 슬래시 명령 ────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch {
    return;
  }

  try {
    if (interaction.commandName === 'join') {
      await handleJoin(interaction);
    } else if (interaction.commandName === 'leave') {
      await handleLeave(interaction);
    } else if (interaction.commandName === 'status') {
      await handleStatus(interaction);
    }
  } catch (err) {
    console.error('명령 처리 오류:', err);
    try {
      await interaction.editReply(`❌ 오류: ${err.message}`);
    } catch {}
  }
});

async function handleJoin(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.editReply('❌ 먼저 음성 채널에 입장한 후 `/join`을 호출해주세요.');
    return;
  }

  const existing = sessions.get(interaction.guildId);
  if (existing) {
    await interaction.editReply(
      `❌ 이미 #${existing.voiceChannelName}에서 녹음 중입니다. ` +
      `종료하려면 해당 채널에서 \`/leave\`를 호출해주세요.`,
    );
    return;
  }

  // DB INSERT (status='recording')
  const { rows } = await query(
    `INSERT INTO meetings
       (guild_id, guild_name, voice_channel_id, voice_channel_name,
        invoked_by_user_id, invoked_by_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, started_at`,
    [
      interaction.guildId,
      interaction.guild.name,
      voiceChannel.id,
      voiceChannel.name,
      interaction.user.id,
      member.displayName,
    ],
  );
  const meetingId = Number(rows[0].id);
  const startedAt = rows[0].started_at;

  // voice channel join (03 체크포인트에서 recorder.js로 분리·receiver.subscribe 추가)
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    try { connection.destroy(); } catch {}
    await query(
      "UPDATE meetings SET status='failed', error_message=$2 WHERE id=$1",
      [meetingId, `voice connection ready timeout: ${err.message}`],
    );
    await interaction.editReply('❌ 음성 채널 연결 실패. 잠시 후 다시 시도해주세요.');
    return;
  }

  // 세션 등록 — recorder가 speakerSegments에 데이터 채움
  const session = {
    meetingId,
    guildName: interaction.guild.name,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    startedAt,
    invokedByUserId: interaction.user.id,
    invokedByName: member.displayName,
    voiceConnection: connection,
    receiver: connection.receiver,
    speakerSegments: new Map(),
    autoLeaveTimer: null,
  };
  sessions.set(interaction.guildId, session);

  // 화자별 PCM 캡처 시작 (recorder.js)
  startRecording(session, voiceChannel);

  // 입장 공지 Embed — 음성 채널 텍스트 채팅
  const embed = new EmbedBuilder()
    .setTitle('🎙️ 회의 녹음 시작')
    .setDescription(
      `<@${interaction.user.id}>님이 회의 녹음을 시작했습니다.\n` +
      `종료하려면 \`/leave\`를 호출하세요.\n` +
      (TRANSCRIPT_CHANNEL
        ? `트랜스크립트는 <#${TRANSCRIPT_CHANNEL}>에 쓰레드로 게시됩니다.`
        : ''),
    )
    .setColor(0x5865F2)
    .setTimestamp();

  try {
    await voiceChannel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('음성 채널 공지 실패 (텍스트 권한 없음 가능):', err.message);
  }

  await interaction.editReply(`✅ #${voiceChannel.name}에서 녹음을 시작했습니다.`);
}

async function handleLeave(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.editReply('❌ 현재 진행 중인 회의가 없습니다.');
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== session.voiceChannelId) {
    await interaction.editReply(
      `❌ \`/leave\`는 봇이 있는 음성 채널(#${session.voiceChannelName}) 참여자만 호출할 수 있습니다.`,
    );
    return;
  }

  await interaction.editReply('🔄 회의 종료 처리 중... transcript와 요약이 곧 게시됩니다.');

  if (session.autoLeaveTimer) clearTimeout(session.autoLeaveTimer);
  sessions.delete(interaction.guildId);

  try {
    await finalizeMeeting(client, session, 'manual-leave');
  } catch (err) {
    console.error('finalizeMeeting 실패 (manual-leave):', err);
    sendAlert(`⚠️ 회의 ${session.meetingId} 후처리 실패: ${err.message}`).catch(() => {});
  }
}

async function handleStatus(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.editReply('현재 진행 중인 회의 없음.');
    return;
  }
  const elapsed = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000);
  await interaction.editReply(
    `🎙️ 녹음 중: #${session.voiceChannelName} · 시작자: ${session.invokedByName} · 경과 ${elapsed}초`,
  );
}

// ── 자동 leave (봇만 남은 음성 채널) ──────────────

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = (newState ?? oldState).guild;
  if (!guild) return;

  const session = sessions.get(guild.id);
  if (!session) return;

  const channel = guild.channels.cache.get(session.voiceChannelId);
  if (!channel) return;

  const nonBotCount = channel.members.filter((m) => !m.user.bot).size;

  if (nonBotCount === 0) {
    if (session.autoLeaveTimer) return;
    session.autoLeaveTimer = setTimeout(async () => {
      console.log(`⏰ 음성 채널 비어있음 → 자동 /leave (meeting ${session.meetingId})`);
      sessions.delete(guild.id);
      try {
        await finalizeMeeting(client, session, 'auto-empty-channel');
      } catch (err) {
        console.error('finalizeMeeting 실패 (auto-empty-channel):', err);
        sendAlert(`⚠️ 회의 ${session.meetingId} 자동 후처리 실패: ${err.message}`).catch(() => {});
      }
    }, AUTO_LEAVE_SEC * 1000);
  } else if (session.autoLeaveTimer) {
    clearTimeout(session.autoLeaveTimer);
    session.autoLeaveTimer = null;
  }
});

// ── 로그인 ─────────────────────────────────────────

client.login(process.env.DISCORD_BOT_TOKEN);
