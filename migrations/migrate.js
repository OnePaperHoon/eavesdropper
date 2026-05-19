import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 마이그레이션 이력 테이블 생성
await pool.query(`
  CREATE TABLE IF NOT EXISTS migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const applied = new Set(
  (await pool.query('SELECT filename FROM migrations')).rows.map((r) => r.filename)
);

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`⏭️  ${file} (이미 적용됨)`);
    continue;
  }

  const sql = readFileSync(join(__dirname, file), 'utf8');
  try {
    await pool.query(sql);
    await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
    console.log(`✅ ${file} 적용 완료`);
    count++;
  } catch (err) {
    console.error(`❌ ${file} 실패:`, err.message);
    process.exit(1);
  }
}

if (count === 0) console.log('모든 마이그레이션이 이미 적용되어 있습니다.');
else console.log(`\n총 ${count}개 마이그레이션 완료`);

await pool.end();
