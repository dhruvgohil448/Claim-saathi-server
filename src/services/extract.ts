/** Text extraction: pdf-parse for PDFs, tesseract.js for images (lazy, only when OCR_ENABLED=true). */
import { env } from '../config/env';

// pdf-parse 1.x runs a self-test when imported from its index; import the library file directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (b: Buffer) => Promise<{ text: string; numpages: number }> = require('pdf-parse/lib/pdf-parse.js');

export interface Extracted {
  text: string;
  method: 'pdf' | 'ocr' | 'none';
  pages?: number;
  ocrConfidence?: number; // 0..1, images only
  note?: string;
}

export async function extractText(buffer: Buffer, mimeType: string): Promise<Extracted> {
  try {
    if (mimeType === 'application/pdf') {
      const r = await pdfParse(buffer);
      return { text: normalize(r.text), method: 'pdf', pages: r.numpages };
    }
    if (mimeType.startsWith('image/')) {
      if (!env.ocrEnabled) return { text: '', method: 'none', note: 'Image upload: OCR disabled (set OCR_ENABLED=true to read photos).' };
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      try {
        const { data } = await worker.recognize(buffer);
        return { text: normalize(data.text), method: 'ocr', ocrConfidence: (data.confidence ?? 0) / 100 };
      } finally {
        await worker.terminate();
      }
    }
    if (mimeType.startsWith('text/')) return { text: normalize(buffer.toString('utf8')), method: 'pdf' };
  } catch (e) {
    return { text: '', method: 'none', note: `Could not read the file: ${(e as Error).message}` };
  }
  return { text: '', method: 'none', note: 'Unsupported file type' };
}

const normalize = (t: string) => t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
