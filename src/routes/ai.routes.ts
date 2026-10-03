import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { chat } from '../services/assistant';

const r = Router();
r.use(auth);

/** Claim Saathi assistant, grounded in the user's policy + claim rows. */
r.post('/chat', async (req, res) => {
  const { message, claimId } = z.object({ message: z.string().trim().min(1).max(500), claimId: z.string().optional() }).parse(req.body);
  res.json(await chat(req.user!, message, claimId));
});

export default r;
