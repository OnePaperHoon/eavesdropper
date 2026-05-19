import { AttachmentBuilder, ChannelType, EmbedBuilder } from 'discord.js';
import { statSync } from 'fs';
import { Buffer } from 'buffer';
import { query } from './db.js';

const TRANSCRIPT_CHANNEL = process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;

const pad2 = (n) => String(n).padStart(2, '0');

function makeThreadName(summary, meeting) {
  const d = new Date(meeting.startedAt);
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());

  if (summary?.thread_title && summary.thread_title.trim()) {
    const prefix = `[${mm}-${dd}] `;
    const maxBody = 100 - prefix.length;
    return prefix + summary.thread_title.trim().slice(0, maxBody);
  }
  // fallback
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const name = `[${mm}-${dd} ${hh}:${mi}] 회의록 — ${meeting.invokedByName ?? '?'}`;
  return name.slice(0, 100);
}

function buildSummaryEmbed(summary, meeting, speakers) {
  const speakerNames = speakers.map((s) => s.displayName).join(', ');

  const lines = [
    '**📋 Notes from the Call**',
    '',
    `**👥 Speakers:** ${speakerNames}`,
    '',
    summary?.one_line_summary || '',
    '',
  ];

  for (const sec of summary?.dynamic_sections || []) {
    lines.push(`**${sec.emoji ?? '•'} ${sec.title ?? ''}**`);
    if (sec.body) lines.push(sec.body);
    lines.push('');
  }

  lines.push('**✅ Decision Tracking**');
  if (summary?.decisions?.length) {
    summary.decisions.forEach((d) => lines.push(`• ${d}`));
  } else {
    lines.push('명시된 결정사항 없음.');
  }
  lines.push('');

  lines.push('**🧩 Next Steps & Responsibilities**');
  if (summary?.next_steps?.length) {
    summary.next_steps.forEach((n) => lines.push(`• ${n}`));
  } else {
    lines.push('할당된 후속 작업 없음.');
  }

  // Embed description 4096자 한도 안전 절단
  const desc = lines.join('\n').slice(0, 4000);

  return new EmbedBuilder()
    .setDescription(desc)
    .setColor(0x57F287)
    .setTimestamp(meeting.endedAt);
}

/**
 * /leave 후처리의 마지막 단계 — 쓰레드 생성 + 첨부 + DB 저장.
 *
 * @param {object} opts
 * @param {import('discord.js').Client} opts.client
 * @param {object} opts.session   bot.js에 등록되었던 MeetingSession
 * @param {object} opts.summary   summarizer 산출물
 * @param {string} opts.transcriptText
 * @param {Array<{path:string, partIndex:number, durationSec:number}>} opts.mp3Parts
 * @param {object} opts.meeting   { guildName, startedAt, endedAt, durationSeconds, invokedByName }
 * @param {Array<{userId:string, displayName:string}>} opts.speakers
 */
export async function publishMeeting({
  client, session, summary, transcriptText, mp3Parts, meeting, speakers,
}) {
  if (!TRANSCRIPT_CHANNEL) {
    throw new Error('DISCORD_TRANSCRIPT_CHANNEL_ID env 미설정');
  }

  const channel = await client.channels.fetch(TRANSCRIPT_CHANNEL);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(
      `DISCORD_TRANSCRIPT_CHANNEL_ID (${TRANSCRIPT_CHANNEL})가 일반 텍스트 채널이 아닙니다.`,
    );
  }

  // 1) starter 메시지 — 요약 Embed + transcript .txt 첨부
  const embed = buildSummaryEmbed(summary, meeting, speakers);
  const transcriptBuf = Buffer.from(transcriptText, 'utf8');
  const transcriptAttachment = new AttachmentBuilder(transcriptBuf, {
    name: `transcript_${session.meetingId}.txt`,
  });

  const starterMsg = await channel.send({
    embeds: [embed],
    files: [transcriptAttachment],
  });

  // 2) 쓰레드 생성 (starter message에서)
  const threadName = makeThreadName(summary, meeting);
  const thread = await starterMsg.startThread({
    name: threadName,
    autoArchiveDuration: 10080,  // 7 days
  });

  // 3) MP3 part 첨부 — 한 part = 한 메시지 (Discord 25MB/첨부 한도 안전)
  const partRows = [];
  for (let i = 0; i < mp3Parts.length; i++) {
    const part = mp3Parts[i];
    let size = 0;
    try { size = statSync(part.path).size; } catch {}
    const file = new AttachmentBuilder(part.path, { name: `part_${part.partIndex}.mp3` });
    const msg = await thread.send({
      content: `🎵 part ${part.partIndex}/${mp3Parts.length}`,
      files: [file],
    });
    const url = msg.attachments.first()?.url ?? null;
    partRows.push({
      partIndex: part.partIndex,
      url,
      durationSec: part.durationSec,
      size,
    });
  }

  // 4) DB 저장 — meetings UPDATE + speakers/audio_parts INSERT
  await query(
    `UPDATE meetings SET
       status = 'completed',
       ended_at = $2,
       duration_seconds = $3,
       thread_id = $4,
       thread_title = $5,
       transcript_text = $6,
       summary_json = $7
     WHERE id = $1`,
    [
      session.meetingId,
      meeting.endedAt,
      meeting.durationSeconds,
      thread.id,
      threadName,
      transcriptText,
      summary,
    ],
  );

  for (const sp of speakers) {
    await query(
      `INSERT INTO meeting_speakers (meeting_id, user_id, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [session.meetingId, sp.userId, sp.displayName],
    );
  }

  for (const p of partRows) {
    await query(
      `INSERT INTO meeting_audio_parts
         (meeting_id, part_index, discord_attachment_url, duration_seconds, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.meetingId, p.partIndex, p.url, p.durationSec, p.size],
    );
  }

  return { threadId: thread.id, threadName };
}
