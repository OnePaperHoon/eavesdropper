import OpenAI from 'openai';
import { createReadStream } from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const LANG = process.env.WHISPER_LANGUAGE || 'ko';

/**
 * 화자 MP3를 Whisper API에 보내 segment-level timestamps를 받는다.
 * `start`/`end`는 MP3 파일 내부 시간 (초). 회의 시작 기준 elapsed 매핑은
 * transcript-builder.mergeAcrossSpeakers가 담당.
 *
 * @param {string} mp3Path
 * @returns {Promise<Array<{start:number, end:number, text:string}>>}
 */
export async function transcribeSpeakerMp3(mp3Path) {
  try {
    const resp = await openai.audio.transcriptions.create({
      file: createReadStream(mp3Path),
      model: MODEL,
      language: LANG,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const segments = Array.isArray(resp.segments) ? resp.segments : [];
    return segments.map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || '').trim(),
    })).filter((s) => s.text.length > 0);
  } catch (err) {
    console.error(`Whisper 실패 (${mp3Path}):`, err.message);
    return [{ start: 0, end: 0, text: '[STT 실패]' }];
  }
}
