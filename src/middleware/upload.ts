/**
 * Single-file multipart upload used by every upload route (claim documents, query replies, policy PDFs).
 * - Accepts PDF, JPG/JPEG, PNG, WEBP and HEIC/HEIF up to 10 MB.
 * - Any field name works; "file" is preferred, then "document", "doc", "attachment", "upload", "image", "pdf", "photo".
 * - Files sent as application/octet-stream (common from iOS/Android pickers) are typed from their extension.
 */
import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../utils/errors';

export const MAX_UPLOAD_MB = 10;
const BY_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence']);
const PREFERRED = ['file', 'document', 'doc', 'attachment', 'upload', 'image', 'pdf', 'photo'];
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

function normalize(file: Express.Multer.File) {
  let mime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED.has(mime) && BY_EXT[ext(file.originalname || '')]) mime = BY_EXT[ext(file.originalname)];
  if (mime === 'image/jpg' || mime === 'image/pjpeg') mime = 'image/jpeg';
  if (mime === 'image/heic-sequence') mime = 'image/heic';
  file.mimetype = mime;
  if (!file.originalname || !file.originalname.includes('.')) file.originalname = `${file.originalname || file.fieldname || 'upload'}.${Object.entries(BY_EXT).find(([, m]) => m === mime)?.[0] ?? 'bin'}`;
  return ALLOWED.has(mime);
}

const inner = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) =>
    normalize(file) ? cb(null, true) : cb(new AppError(415, `Unsupported file type (${file.mimetype || 'unknown'}). Upload a PDF, JPG, PNG or HEIC file.`, 'UNSUPPORTED_FILE_TYPE')),
}).any();

function anyFile(req: Request, res: Response, next: NextFunction) {
  inner(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, `File is larger than ${MAX_UPLOAD_MB} MB. Upload a smaller file or a clearer photo.`, 'FILE_TOO_LARGE'));
      return next(new AppError(400, err.message, 'UPLOAD_ERROR'));
    }
    if (err) return next(err);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    req.file = PREFERRED.map((n) => files.find((f) => f.fieldname === n)).find(Boolean) ?? files[0];
    if (req.file && req.file.size === 0) return next(new AppError(400, 'The uploaded file is empty.', 'EMPTY_FILE'));
    next();
  });
}

/** Drop-in for multer's upload.single(...): the field name argument is kept for readability but any field works. */
export const upload = { single: (_field?: string) => anyFile };
