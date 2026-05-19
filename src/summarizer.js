import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(
  join(__dirname, '..', 'prompts', 'summary.txt'),
  'utf8',
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';

// json_schema strict — 모델이 스키마 위반 응답을 자체 거부.
// 클라이언트 파싱 실패는 사실상 네트워크/타임아웃 경우만.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thread_title', 'one_line_summary', 'dynamic_sections', 'decisions', 'next_steps'],
  properties: {
    thread_title: {
      type: 'string',
      description: '50자 이내 한국어 한 줄 핵심 주제',
    },
    one_line_summary: {
      type: 'string',
      description: '회의 전체 1~2문장 한국어 요약',
    },
    dynamic_sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['emoji', 'title', 'body'],
        properties: {
          emoji: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    decisions: {
      type: 'array',
      items: { type: 'string' },
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

const FALLBACK = () => ({
  thread_title: null,
  one_line_summary: '요약 생성 실패 — transcript 본문 참조',
  dynamic_sections: [],
  decisions: [],
  next_steps: [],
});

/**
 * transcript 텍스트를 OpenAI gpt-4o-mini에 보내 구조화 요약을 받는다.
 * json_schema strict 적용으로 스키마 위반 응답 사실상 0.
 *
 * @param {string} transcriptText
 * @returns {Promise<object>} SUMMARY_SCHEMA 형태
 */
export async function summarizeTranscript(transcriptText) {
  const system = PROMPT_TEMPLATE.replace('{{TRANSCRIPT}}', transcriptText);

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '위 스키마대로 JSON 객체를 출력하세요.' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'meeting_summary',
          strict: true,
          schema: SUMMARY_SCHEMA,
        },
      },
    });

    const text = resp.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(text);

    // 50자 안전 절단 (스키마가 maxLength를 직접 지원하지 않는 strict 환경 대비 안전망)
    if (parsed.thread_title && parsed.thread_title.length > 50) {
      parsed.thread_title = parsed.thread_title.slice(0, 50);
    }
    return parsed;
  } catch (err) {
    console.error('OpenAI 요약 실패:', err.message);
    return FALLBACK();
  }
}
