/**
 * File storage. Supabase Storage (private bucket "claim-files") when SUPABASE_SERVICE_KEY is set,
 * otherwise local disk (uploads/). Bundled demo documents live in sample-data/documents.
 * Keys: "supabase/<path>", "local/<path>", "sample/<path>".
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const ROOT = path.resolve(__dirname, '..', '..');
const UPLOADS = path.join(ROOT, 'uploads');
const SAMPLES = path.join(ROOT, 'sample-data', 'documents');

let sb: SupabaseClient | null = null;
export const storageMode = () => (env.supabaseUrl && env.supabaseServiceKey ? 'supabase' : 'local');
function client() {
  if (!sb) sb = createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false } });
  return sb;
}

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(-80);

export async function putFile(buffer: Buffer, fileName: string, mimeType: string, folder: string): Promise<string> {
  const rel = `${safeName(folder)}/${Date.now()}-${safeName(fileName)}`;
  if (storageMode() === 'supabase') {
    const { error } = await client().storage.from(env.supabaseBucket).upload(rel, buffer, { contentType: mimeType, upsert: false });
    if (!error) return `supabase/${rel}`;
    console.warn('[storage] Supabase upload failed, saving locally:', error.message);
  }
  const full = path.join(UPLOADS, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return `local/${rel}`;
}

/** Resolve a local/sample key to an absolute path inside its base folder (prevents path traversal). */
export function localPath(key: string): string | null {
  const [kind, ...rest] = key.split('/');
  const base = kind === 'sample' ? SAMPLES : kind === 'local' ? UPLOADS : null;
  if (!base) return null;
  const full = path.resolve(base, rest.join('/'));
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

export async function readFile(key: string): Promise<Buffer | null> {
  if (key.startsWith('supabase/')) {
    const { data, error } = await client().storage.from(env.supabaseBucket).download(key.slice('supabase/'.length));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  const p = localPath(key);
  return p && fs.existsSync(p) ? fs.readFileSync(p) : null;
}

const sign = (docId: string, exp: number) => crypto.createHmac('sha256', env.jwtSecret).update(`${docId}.${exp}`).digest('hex').slice(0, 32);
export const verifyFileSig = (docId: string, exp: number, sig: string) =>
  exp > Date.now() / 1000 && crypto.timingSafeEqual(Buffer.from(sign(docId, exp)), Buffer.from(String(sig).padEnd(32, '0').slice(0, 32)));

/** Short-lived URL the dashboard / app can put straight into <img> or <iframe>. */
export async function signedUrl(key: string, docId: string, baseUrl: string, seconds = 900): Promise<string> {
  if (key.startsWith('supabase/') && storageMode() === 'supabase') {
    const { data, error } = await client().storage.from(env.supabaseBucket).createSignedUrl(key.slice('supabase/'.length), seconds);
    if (!error && data?.signedUrl) return data.signedUrl;
  }
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `${baseUrl}/api/files/${docId}?exp=${exp}&sig=${sign(docId, exp)}`;
}

export function mimeFromName(n: string) {
  const e = n.toLowerCase().split('.').pop();
  return e === 'pdf' ? 'application/pdf' : e === 'png' ? 'image/png' : e === 'jpg' || e === 'jpeg' ? 'image/jpeg' : e === 'webp' ? 'image/webp' : 'application/octet-stream';
}
