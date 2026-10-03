import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { chat, BASE_SUGGESTIONS } from '../services/assistant';
import * as sarvam from '../services/sarvam';
import { englishQuestion, hindiAnswer, HI_SUGGESTIONS, intentOf, isDevanagari } from '../services/hindi';
import { AppError } from '../utils/errors';

const r = Router();
r.use(auth);

/** Claim Saathi assistant, grounded in the user's policy + claim rows. lang=hi → reply in Hindi (Sarvam translate, else deterministic Hindi). */
r.post('/chat', async (req, res) => {
  const { message, claimId, lang } = z.object({ message: z.string().trim().min(1).max(500), claimId: z.string().optional(), lang: z.string().optional() }).parse(req.body);
  const hi = (lang || '').toLowerCase().startsWith('hi') || (!lang && isDevanagari(message));
  const q = isDevanagari(message) ? englishQuestion(intentOf(message), message) : message;
  const out = await chat(req.user!, q, claimId);
  if (!hi) return void res.json({ ...out, lang: 'en' });
  const en = (out as { answer?: string }).answer ?? '';
  const viaSarvam = intentOf(message) === 'OTHER' ? await sarvam.translate(en, 'hi', 'en') : null;
  const answer = viaSarvam ?? (await hindiAnswer(req.user!.id, message, claimId));
  res.json({ ...out, answer, answerEn: en, lang: 'hi', translatedBy: viaSarvam ? 'sarvam' : 'saathi-rules', suggestions: HI_SUGGESTIONS, followUps: HI_SUGGESTIONS.slice(0, 3) });
});

/** Opening chips + greeting for the Chat screen (before the first message). */
r.get('/suggestions', (req, res) => {
  const first = req.user!.name && req.user!.name !== 'New user' ? req.user!.name.split(' ')[0] : '';
  if (String(req.query.lang || '').startsWith('hi')) return void res.json({ greeting: `नमस्ते${first ? ` ${first}` : ''}! मैं साथी हूँ। अपने क्लेम, पॉलिसी या भुगतान के बारे में बोलकर या लिखकर पूछें।`, suggestions: HI_SUGGESTIONS, lang: 'hi' });
  res.json({ greeting: `Hi ${first || 'there'}! Ask me about your claims, policy cover, bank balances or medical spend.`, suggestions: BASE_SUGGESTIONS, lang: 'en' });
});

// ---- Voice Saathi (Sarvam AI) ----
r.get('/voice/status', (_req, res) => {
  res.json({ sarvam: sarvam.sarvamEnabled(), stt: sarvam.sarvamEnabled() ? 'sarvam' : 'unavailable', tts: sarvam.sarvamEnabled() ? 'sarvam' : 'device', languages: ['en-IN', 'hi-IN', 'mr-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN'] });
});

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).any();
/** Speech-to-text. multipart (any file field) or JSON { audioBase64, mimeType, lang }. */
r.post('/voice/stt', audioUpload, async (req, res) => {
  const f = ((req.files as Express.Multer.File[] | undefined) ?? [])[0];
  const body = (req.body ?? {}) as { audioBase64?: string; mimeType?: string; lang?: string };
  const buf = f?.buffer ?? (body.audioBase64 ? Buffer.from(body.audioBase64.replace(/^data:[^,]+,/, ''), 'base64') : null);
  if (!buf || !buf.length) throw new AppError(400, 'Send the recording as a file or audioBase64.', 'NO_AUDIO');
  if (!sarvam.sarvamEnabled()) return void res.status(503).json({ error: { code: 'VOICE_NOT_CONFIGURED', message: 'voice not configured' }, configured: false, text: null });
  const out = await sarvam.speechToText(buf, f?.mimetype || body.mimeType || 'audio/mp4', body.lang);
  if (!out) return void res.status(502).json({ error: { code: 'STT_FAILED', message: 'Could not understand the recording. Please try again.' }, configured: true, text: null });
  res.json({ text: out.text, language: out.language, provider: 'sarvam', configured: true });
});

/** Text-to-speech. Returns audioBase64 (wav) from Sarvam bulbul, or null → app speaks with on-device TTS. */
r.post('/voice/tts', async (req, res) => {
  const { text, lang } = z.object({ text: z.string().trim().min(1).max(2000), lang: z.string().optional() }).parse(req.body);
  const out = await sarvam.textToSpeech(text, lang || (isDevanagari(text) ? 'hi' : 'en'));
  res.json(out ? { ...out, provider: 'sarvam', lang: sarvam.langCode(lang || (isDevanagari(text) ? 'hi' : 'en')) } : { audioBase64: null, mimeType: null, provider: 'device', lang: sarvam.langCode(lang || (isDevanagari(text) ? 'hi' : 'en')) });
});

r.post('/translate', async (req, res) => {
  const { text, target, source } = z.object({ text: z.string().trim().min(1).max(1000), target: z.string().default('hi'), source: z.string().optional() }).parse(req.body);
  const t = await sarvam.translate(text, target, source || 'auto');
  res.json({ text: t ?? text, translated: !!t, provider: t ? 'sarvam' : 'none' });
});

export default r;
