import 'dotenv/config';

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const env = {
  port: num(process.env.PORT, 5000),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  supabaseBucket: process.env.SUPABASE_BUCKET || 'claim-files',
  mockAI: bool(process.env.MOCK_AI, true),
  aiProvider: (process.env.AI_PROVIDER || 'openai').toLowerCase() as 'openai' | 'gemini',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  agentPlanner: (process.env.AGENT_PLANNER || 'rules').toLowerCase() as 'rules' | 'llm',
  ocrEnabled: bool(process.env.OCR_ENABLED, false),
  autoVerifyConfidence: num(process.env.AUTO_VERIFY_CONFIDENCE, 0.8),
  escalationAmount: num(process.env.ESCALATION_AMOUNT, 100000),
  followupCron: process.env.FOLLOWUP_CRON || '*/5 * * * *',
  stuckAfterMinutes: num(process.env.STUCK_AFTER_MINUTES, 240),
  maxReminders: num(process.env.MAX_REMINDERS, 2),
  autoSettleAfterMinutes: num(process.env.AUTO_SETTLE_AFTER_MINUTES, 10),
};

if (env.jwtSecret.startsWith('dev-only') && env.nodeEnv === 'production') {
  console.warn('[env] JWT_SECRET is not set. Set a long random value in production.');
}

/** True when a real LLM can be called. */
export const llmEnabled = () =>
  !env.mockAI && ((env.aiProvider === 'openai' && !!env.openaiKey) || (env.aiProvider === 'gemini' && !!env.geminiKey));
