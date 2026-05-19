// 의존성 가드 — node 내장 모듈만 사용 (자기 자신은 외부 의존성 0).
// scripts/cli.js, scripts/install.js가 외부 패키지를 정적 import하기 전에 호출.
// 누락 시 친절한 한국어 안내 후 process.exit(1).

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// CLI/Install이 직접 의존하는 핵심 패키지만 검사.
// (봇 런타임이 추가로 쓰는 discord.js 등은 검사 안 함 — npm install이 한 번 성공하면 묶음)
const REQUIRED = ['@clack/prompts'];

export function ensureDeps() {
  const missing = REQUIRED.filter((pkg) => {
    const sentinel = join(ROOT, 'node_modules', ...pkg.split('/'), 'package.json');
    return !existsSync(sentinel);
  });

  if (missing.length === 0) return;

  console.error('');
  console.error('❌ 의존성이 설치되지 않았습니다.');
  console.error(`   누락: ${missing.join(', ')}`);
  console.error('');
  console.error('   먼저 다음 명령을 실행해주세요:');
  console.error('');
  console.error('     npm install');
  console.error('');
  console.error('   참고:');
  console.error('     - @discordjs/opus는 optionalDependencies (ARM64에서 빌드 실패해도 무방, opusscript fallback)');
  console.error('     - ffmpeg는 시스템 패키지: sudo apt install -y ffmpeg');
  console.error('');
  process.exit(1);
}
