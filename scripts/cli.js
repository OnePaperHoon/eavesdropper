#!/usr/bin/env node
/**
 * eavesdropper 통합 CLI — `npm run cli`
 * threads-make의 scripts/cli.js 패턴 차용 (별개 프로젝트, 코드만 복사).
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureDeps } from './_ensure-deps.js';
import { promptDatabaseUrl } from './_db-url-prompt.js';

// 외부 패키지 import 전에 의존성 가드 — 없으면 친절한 안내 후 종료.
ensureDeps();

// dynamic import: 가드 통과한 다음에만 평가됨.
const p = await import('@clack/prompts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE_PATH = join(ROOT, '.env.example');
const SUMMARY_PROMPT_FILE = join(ROOT, 'prompts', 'summary.txt');

// ── 공통 헬퍼 ─────────────────────────────────────────

function run(cmd, args = []) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
}

function ifCancel(val) {
  if (p.isCancel(val)) {
    p.cancel('취소됐습니다.');
    process.exit(0);
  }
  return val;
}

// ── .env 읽기/쓰기 ────────────────────────────────────

function readEnvKey(key) {
  if (!existsSync(ENV_PATH)) return '';
  const m = readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : '';
}

function writeEnvKey(key, value) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^(${key}=)(.*)$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `$1${value}`);
  } else {
    content = content.replace(/\n*$/, '\n') + `${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content, 'utf8');
}

// ── 환경 변수 섹션 정의 (SPEC §5 그대로) ──────────────

const ENV_SECTIONS = [
  {
    label: 'Discord',
    vars: [
      { key: 'DISCORD_BOT_TOKEN',             label: '봇 토큰',                   secret: true  },
      { key: 'DISCORD_CLIENT_ID',             label: '클라이언트 ID',             secret: false },
      { key: 'DISCORD_GUILD_ID',              label: '서버 ID',                   secret: false },
      { key: 'DISCORD_TRANSCRIPT_CHANNEL_ID', label: '#회의록 채널 ID',           secret: false },
      { key: 'DISCORD_ALERTS_CHANNEL_ID',     label: '#alerts 채널 ID',           secret: false },
    ],
  },
  {
    label: 'OpenAI (STT + 요약 단일 vendor — ADR-5)',
    vars: [
      { key: 'OPENAI_API_KEY',     label: 'OpenAI API 키 (Whisper + gpt-4o-mini 공유)', secret: true  },
      { key: 'WHISPER_MODEL',      label: 'Whisper 모델 (기본 whisper-1)',              secret: false },
      { key: 'WHISPER_LANGUAGE',   label: '언어 힌트 (기본 ko)',                        secret: false },
      { key: 'SUMMARY_MODEL',      label: '요약 모델 (기본 gpt-4o-mini)',               secret: false },
    ],
  },
  {
    label: 'PostgreSQL (threads-make와 별도 인스턴스)',
    vars: [
      { key: 'DATABASE_URL', label: '연결 정보 (host/port/db/user/password 5필드 분리 입력)', secret: true },
    ],
  },
  {
    label: '녹음 정책',
    vars: [
      { key: 'AUTO_LEAVE_EMPTY_SECONDS',  label: '봇 단독 채널 자동 leave 대기 (초, 기본 30)', secret: false },
      { key: 'MP3_PART_DURATION_MINUTES', label: 'MP3 파트 분할 간격 (분, 기본 30)',          secret: false },
      { key: 'MP3_BITRATE_KBPS',          label: 'MP3 비트레이트 (kbps, 기본 32)',            secret: false },
      { key: 'END_BEHAVIOR_SILENCE_MS',   label: '발화 cut 침묵 임계 (ms, 기본 1000)',        secret: false },
    ],
  },
  {
    label: '로그',
    vars: [
      { key: 'LOG_LEVEL',  label: '로그 레벨 (info/debug/warn/error)',     secret: false },
      { key: 'TZ_DISPLAY', label: 'transcript 메타 표시 타임존 (기본 UTC)', secret: false },
    ],
  },
];

// ── 메뉴 핸들러들 ─────────────────────────────────────

async function handleEnvEdit() {
  const sectionIdx = ifCancel(await p.select({
    message: '편집할 환경 변수 섹션을 선택하세요',
    options: ENV_SECTIONS.map((sec, i) => ({ value: i, label: sec.label })),
  }));
  const section = ENV_SECTIONS[sectionIdx];

  const varKey = ifCancel(await p.select({
    message: `${section.label} — 편집할 항목 선택`,
    options: section.vars.map((v) => {
      const current = readEnvKey(v.key);
      const display = v.secret && current
        ? '••••••'
        : (current || '<미설정>');
      return { value: v.key, label: `${v.label}  [${display}]` };
    }),
  }));

  const varDef = section.vars.find((v) => v.key === varKey);

  let newValue;
  if (varKey === 'DATABASE_URL') {
    // 특수 처리: 5필드 분리 입력 + 자동 조립 (한 줄 connection string은 실수 빈발)
    newValue = await promptDatabaseUrl(p, ifCancel, readEnvKey(varKey));
  } else {
    newValue = ifCancel(await (varDef.secret ? p.password : p.text)({
      message: `${varDef.label} 새 값`,
      placeholder: readEnvKey(varKey),
    }));
  }

  writeEnvKey(varKey, newValue);
  p.note(`✅ ${varKey} 저장 완료`);
}

async function handlePromptEdit() {
  p.note(
    `prompts/summary.txt 를 외부 에디터(예: nano)에서 직접 편집하세요.\n` +
    `경로: ${SUMMARY_PROMPT_FILE}`,
  );
  const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  run(editor, [SUMMARY_PROMPT_FILE]);
}

async function handleDb() {
  const action = ifCancel(await p.select({
    message: 'DB 작업 선택',
    options: [
      { value: 'migrate', label: '마이그레이션 실행 (db:migrate)' },
      { value: 'cleanup', label: 'stuck 회의 청소 (1시간+ in-progress → failed)' },
      { value: 'back', label: '◀ 뒤로' },
    ],
  }));

  if (action === 'migrate') {
    run('npm', ['run', 'db:migrate']);
  } else if (action === 'cleanup') {
    const { default: pool } = await import('../src/db.js');
    try {
      const r = await pool.query(
        `UPDATE meetings
         SET status = 'failed',
             error_message = COALESCE(error_message, 'manual cleanup')
         WHERE status IN ('recording','transcribing','summarizing')
           AND started_at < NOW() - INTERVAL '1 hour'
         RETURNING id`,
      );
      p.note(`🧹 stuck 회의 ${r.rowCount}건 → failed`);
    } catch (err) {
      p.note(`❌ 실패: ${err.message}`);
    } finally {
      await pool.end();
    }
  }
}

async function handleDiscordRegister() {
  run('npm', ['run', 'discord:register-commands']);
}

async function handleUpdate() {
  const confirm = ifCancel(await p.confirm({
    message: 'git pull + npm install + db:migrate + 슬래시 명령 재등록 + pm2 restart 진행할까요?',
    initialValue: true,
  }));
  if (!confirm) return;

  run('git', ['pull']);
  run('npm', ['install']);
  run('npm', ['run', 'db:migrate']);
  run('npm', ['run', 'discord:register-commands']);
  run('pm2', ['restart', 'eavesdropper']);
  p.note('✅ 업데이트 적용 완료');
}

async function handlePm2() {
  const action = ifCancel(await p.select({
    message: 'PM2 작업 선택',
    options: [
      { value: 'status',  label: 'status (현재 프로세스 상태 확인)' },
      { value: 'start',   label: 'start (ecosystem.config.cjs)' },
      { value: 'restart', label: 'restart eavesdropper' },
      { value: 'stop',    label: 'stop eavesdropper' },
      { value: 'delete',  label: 'delete eavesdropper' },
      { value: 'logs',    label: 'logs eavesdropper (Ctrl+C로 빠져나오기)' },
      { value: 'save',    label: 'save & startup (부팅 자동시작 등록)' },
      { value: 'back',    label: '◀ 뒤로' },
    ],
  }));

  if (action === 'status')  run('pm2', ['status']);
  if (action === 'start')   run('pm2', ['start', 'ecosystem.config.cjs']);
  if (action === 'restart') run('pm2', ['restart', 'eavesdropper']);
  if (action === 'stop')    run('pm2', ['stop', 'eavesdropper']);
  if (action === 'delete')  run('pm2', ['delete', 'eavesdropper']);
  if (action === 'logs')    run('pm2', ['logs', 'eavesdropper']);
  if (action === 'save') {
    run('pm2', ['save']);
    run('pm2', ['startup']);
  }
}

async function handleTest() {
  run('npm', ['run', 'test:record']);
}

async function handleInstall() {
  if (!existsSync(ENV_PATH)) {
    copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    p.note('.env 파일을 .env.example에서 복사했습니다. 이제 값을 채워주세요.');
  }
  run('node', ['scripts/install.js']);
}

// ── 메인 루프 ─────────────────────────────────────────

async function main() {
  p.intro('🎙️  eavesdropper CLI — 회의 요약 봇 운영');

  while (true) {
    const action = ifCancel(await p.select({
      message: '메뉴를 선택하세요',
      options: [
        { value: 'install',  label: '🚀 초기 셋업 (.env 생성 + migrate + 슬래시 등록)' },
        { value: 'env',      label: '⚙️  환경 변수 편집' },
        { value: 'prompt',   label: '🔧 요약 프롬프트 편집 (prompts/summary.txt)' },
        { value: 'db',       label: '🗄️  DB (마이그레이션, stuck 청소)' },
        { value: 'discord',  label: '🤖 Discord 슬래시 명령 재등록' },
        { value: 'update',   label: '📦 업데이트 적용 (pull + install + migrate + register + pm2)' },
        { value: 'pm2',      label: '🎛️  PM2 운영 (start/restart/stop/logs)' },
        { value: 'test',     label: '🧪 테스트 (scripts/test-record.js)' },
        { value: 'exit',     label: '🚪 종료' },
      ],
    }));

    if (action === 'exit') break;
    if (action === 'install') await handleInstall();
    if (action === 'env')     await handleEnvEdit();
    if (action === 'prompt')  await handlePromptEdit();
    if (action === 'db')      await handleDb();
    if (action === 'discord') await handleDiscordRegister();
    if (action === 'update')  await handleUpdate();
    if (action === 'pm2')     await handlePm2();
    if (action === 'test')    await handleTest();
  }

  p.outro('👋 CLI 종료');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
