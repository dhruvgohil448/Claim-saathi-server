/** Sarvam AI (Indian-language speech + translation). All calls fail soft: callers fall back when this returns null. */
const BASE = 'https://api.sarvam.ai';
export const sarvamKey = () => process.env.SARVAM_API_KEY || '';
export const sarvamEnabled = () => !!sarvamKey();

export const langCode = (l?: string | null) => {
  const x = (l || 'en').toLowerCase();
  if (x.includes('-')) return x.replace(/-(\w+)$/, (_m, r) => `-${String(r).toUpperCase()}`);
  return ({ hi: 'hi-IN', en: 'en-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN', bn: 'bn-IN', gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN' } as Record<string, string>)[x] ?? 'hi-IN';
};

async function call(path: string, init: RequestInit, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, { ...init, signal: ac.signal, headers: { 'api-subscription-key': sarvamKey(), ...(init.headers || {}) } });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) { console.warn(`[sarvam] ${path} ${r.status}`, JSON.stringify(j).slice(0, 300)); return null; }
    return j;
  } catch (e) {
    console.warn(`[sarvam] ${path} failed`, (e as Error).message);
    return null;
  } finally { clearTimeout(t); }
}

export async function speechToText(audio: Buffer, mime: string, lang?: string) {
  if (!sarvamEnabled()) return null;
  const fd = new FormData();
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : 'm4a';
  fd.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/mp4' }), `voice.${ext}`);
  fd.append('model', process.env.SARVAM_STT_MODEL || 'saarika:v2.5');
  fd.append('language_code', lang ? langCode(lang) : 'unknown');
  const j = await call('/speech-to-text', { method: 'POST', body: fd });
  if (!j || typeof j.transcript !== 'string') return null;
  return { text: j.transcript as string, language: (j.language_code as string) || (lang ? langCode(lang) : null) };
}

export async function textToSpeech(text: string, lang?: string) {
  if (!sarvamEnabled()) return null;
  const model = process.env.SARVAM_TTS_MODEL || 'bulbul:v2';
  const j = await call('/text-to-speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 1400), language_code: langCode(lang), model, speaker: process.env.SARVAM_TTS_SPEAKER || (model === 'bulbul:v3' ? 'ritu' : 'anushka') }),
  });
  const a = (j?.audios as string[] | undefined)?.join('');
  return a ? { audioBase64: a, mimeType: 'audio/wav', model } : null;
}

export async function translate(text: string, target: string, source = 'auto') {
  if (!sarvamEnabled() || !text.trim()) return null;
  const j = await call('/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text.slice(0, 1000), source_language_code: source === 'auto' ? 'auto' : langCode(source), target_language_code: langCode(target), model: 'mayura:v1' }),
  }, 15000);
  return typeof j?.translated_text === 'string' ? (j.translated_text as string) : null;
}
