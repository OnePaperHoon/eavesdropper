// DATABASE_URL을 5개 필드로 분리 입력받아 자동 조립.
// install.js와 cli.js 양쪽에서 공유.
// 비밀번호에 특수문자가 있어도 URL 인코딩해서 안전하게 처리.

/**
 * @param {object} p     @clack/prompts 모듈
 * @param {Function} ifCancel  cancel 핸들러
 * @param {string|undefined} currentUrl  기존 .env의 DATABASE_URL (있으면 기본값으로 파싱)
 * @returns {Promise<string>}  조립된 postgres:// URL
 */
export async function promptDatabaseUrl(p, ifCancel, currentUrl) {
  // 기본값
  const defaults = {
    host: 'localhost',
    port: '5432',
    database: 'eavesdropper',
    user: 'eavesdropper_user',
  };

  // 기존 URL 파싱 시도 (실패해도 기본값 fallback)
  if (currentUrl && /^postgres(ql)?:\/\//.test(currentUrl)) {
    try {
      const u = new URL(currentUrl);
      if (u.hostname) defaults.host = u.hostname;
      if (u.port) defaults.port = u.port;
      if (u.pathname && u.pathname.length > 1) defaults.database = u.pathname.slice(1);
      if (u.username) defaults.user = decodeURIComponent(u.username);
    } catch {
      // ignore parse errors
    }
  }

  p.note(
    'PostgreSQL 연결 정보를 입력합니다.\n' +
    '같은 머신에 PG가 있다면 호스트=localhost / 포트=5432 그대로 두세요.\n' +
    '5개 필드를 차례로 입력하면 CLI가 자동으로 connection string을 조립합니다.',
  );

  const host = ifCancel(await p.text({
    message: '① PostgreSQL 호스트 (예: localhost, 192.168.1.10, your-rds-endpoint.amazonaws.com)',
    initialValue: defaults.host,
    validate: (v) => (!v || !v.trim() ? '호스트는 비울 수 없습니다.' : undefined),
  }));

  const port = ifCancel(await p.text({
    message: '② PostgreSQL 포트 (기본 5432)',
    initialValue: defaults.port,
    validate: (v) => {
      if (!v || !v.trim()) return '포트는 비울 수 없습니다.';
      if (!/^\d+$/.test(v.trim())) return '숫자만 입력 (예: 5432)';
      const n = Number(v);
      if (n < 1 || n > 65535) return '1~65535 범위로 입력해주세요.';
      return undefined;
    },
  }));

  const database = ifCancel(await p.text({
    message: '③ 데이터베이스 이름 (CREATE DATABASE로 만든 이름, 기본 eavesdropper)',
    initialValue: defaults.database,
    validate: (v) => (!v || !v.trim() ? '데이터베이스 이름은 비울 수 없습니다.' : undefined),
  }));

  const user = ifCancel(await p.text({
    message: '④ PostgreSQL 유저명 (CREATE USER로 만든 이름, 기본 eavesdropper_user)',
    initialValue: defaults.user,
    validate: (v) => (!v || !v.trim() ? '유저명은 비울 수 없습니다.' : undefined),
  }));

  const password = ifCancel(await p.password({
    message: '⑤ PostgreSQL 비밀번호 (특수문자 가능 — CLI가 URL 인코딩 자동 처리)',
    validate: (v) => (!v ? '비밀번호는 비울 수 없습니다.' : undefined),
  }));

  // URL 안전 인코딩 — @ : / ? # 등 특수문자 대비
  const encUser = encodeURIComponent(user.trim());
  const encPass = encodeURIComponent(password);
  const url = `postgres://${encUser}:${encPass}@${host.trim()}:${port.trim()}/${database.trim()}`;

  // 비밀번호만 마스킹한 미리보기
  const masked = `postgres://${encUser}:••••••••@${host.trim()}:${port.trim()}/${database.trim()}`;
  p.note(`조립된 DATABASE_URL:\n${masked}`);

  return url;
}
