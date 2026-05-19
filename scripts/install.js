#!/usr/bin/env node
/**
 * 초기 셋업 TUI — `.env` 빈 값 항목들을 인터랙티브로 채우고
 * migrate + 슬래시 명령 등록까지 자동 수행.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureDeps } from './_ensure-deps.js';
import { promptDatabaseUrl } from './_db-url-prompt.js';

// 외부 패키지 import 전에 의존성 가드.
ensureDeps();

const p = await import('@clack/prompts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE_PATH = join(ROOT, '.env.example');

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

function ifCancel(val) {
  if (p.isCancel(val)) {
    p.cancel('취소됐습니다.');
    process.exit(0);
  }
  return val;
}

function run(cmd, args = []) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
}

// SPEC §5 — 필수 + 선택 환경 변수
const REQUIRED_VARS = [
  { key: 'DISCORD_BOT_TOKEN',             label: 'Discord 봇 토큰',                                secret: true  },
  { key: 'DISCORD_CLIENT_ID',             label: 'Discord 클라이언트(application) ID',             secret: false },
  { key: 'DISCORD_GUILD_ID',              label: 'Discord 서버(Guild) ID',                         secret: false },
  { key: 'DISCORD_TRANSCRIPT_CHANNEL_ID', label: '#회의록 채널 ID (쓰레드 생성 부모)',             secret: false },
  { key: 'OPENAI_API_KEY',                label: 'OpenAI API 키 (Whisper + gpt-4o-mini)',          secret: true  },
  { key: 'DATABASE_URL',                  label: 'PostgreSQL DATABASE_URL (별도 인스턴스)',        secret: true  },
];

const OPTIONAL_VARS = [
  { key: 'DISCORD_ALERTS_CHANNEL_ID', label: '#alerts 채널 ID (선택, 에러·경고용)', secret: false },
];

async function main() {
  p.intro('🎙️  eavesdropper 초기 셋업');

  // .env 없으면 .env.example에서 복사
  if (!existsSync(ENV_PATH)) {
    if (!existsSync(ENV_EXAMPLE_PATH)) {
      p.cancel('.env.example이 없습니다. 프로젝트 루트에서 실행 중인지 확인해주세요.');
      process.exit(1);
    }
    copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    p.note('.env 파일을 .env.example에서 복사했습니다.');
  }

  // 필수 항목 입력
  for (const v of REQUIRED_VARS) {
    const current = readEnvKey(v.key);
    const looksValid = current
      && current.trim()
      && !current.includes('<')
      && (v.key !== 'DATABASE_URL' || /^postgres(ql)?:\/\/.+@.+/.test(current));

    if (looksValid) {
      p.note(`✓ ${v.label} 이미 설정됨`);
      continue;
    }

    let value;
    if (v.key === 'DATABASE_URL') {
      value = await promptDatabaseUrl(p, ifCancel, current);
    } else {
      value = ifCancel(await (v.secret ? p.password : p.text)({
        message: `${v.label} 입력`,
        placeholder: current,
      }));
    }
    writeEnvKey(v.key, value);
  }

  // 선택 항목
  for (const v of OPTIONAL_VARS) {
    const current = readEnvKey(v.key);
    if (current && current.trim()) continue;
    const skip = ifCancel(await p.confirm({
      message: `${v.label} 설정하시겠습니까?`,
      initialValue: false,
    }));
    if (!skip) continue;
    const value = ifCancel(await (v.secret ? p.password : p.text)({
      message: `${v.label} 입력`,
    }));
    writeEnvKey(v.key, value);
  }

  // 자동 후속 작업
  const proceed = ifCancel(await p.confirm({
    message: '이어서 db:migrate + 슬래시 명령 등록을 진행할까요?',
    initialValue: true,
  }));
  if (proceed) {
    p.note('🗄️  DB 마이그레이션 실행');
    const m = run('npm', ['run', 'db:migrate']);
    if (m.status !== 0) {
      p.note('❌ 마이그레이션 실패 — DATABASE_URL을 확인하세요.');
    } else {
      p.note('🤖 슬래시 명령 등록');
      run('npm', ['run', 'discord:register-commands']);
    }
  }

  p.outro(
    '✅ 초기 셋업 완료\n' +
    '다음: `npm run cli` → 🎛️  PM2 운영 → start 로 봇을 띄우세요.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
