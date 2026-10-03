import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { chat, BASE_SUGGESTIONS } from '../services/assistant';

const r = Router();
r.use(auth);

/** Claim Saathi assistant, grounded in the user's policy + claim rows. */
r.post('/chat', async (req, res) => {
  const { message, claimId } = z.object({ message: z.string().trim().min(1).max(500), claimId: z.string().optional() }).parse(req.body);
  res.json(await chat(req.user!, message, claimId));
});

/** Opening chips + greeting for the Chat screen (before the first message). */
r.get('/suggestions', (req, res) => {
  res.json({ greeting: `Hi ${req.user!.name && req.user!.name !== 'New user' ? req.user!.name.split(' ')[0] : 'there'}! Ask me about your claims, policy cover, bank balances or medical spend.`, suggestions: BASE_SUGGESTIONS });
});

export default r;
