export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code = 'ERROR', public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new AppError(400, m, 'BAD_REQUEST', d);
export const unauthorized = (m = 'Please log in') => new AppError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'You do not have access to this') => new AppError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new AppError(404, m, 'NOT_FOUND');
