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

try {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID,
    ),
    { body: commands },
  );
  console.log('✅ 슬래시 명령 등록 완료 (/join, /leave, /status)');
} catch (err) {
  console.error('❌ 슬래시 명령 등록 실패:', err.message);
  process.exit(1);
}
