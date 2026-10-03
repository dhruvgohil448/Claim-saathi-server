import multer from 'multer';
import { badRequest } from '../utils/errors';

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (ALLOWED.includes(file.mimetype) ? cb(null, true) : cb(badRequest('Only PDF, JPG, PNG or WEBP files are allowed'))),
});
