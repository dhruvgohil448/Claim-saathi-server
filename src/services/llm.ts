/**
 * Thin REST client for OpenAI or Gemini (chosen by AI_PROVIDER). No SDKs, so it stays light on Render.
 * - completeJSON(): asks for strict JSON and returns the parsed object (callers validate with zod)
 * - runToolLoop(): function calling loop used by the Claim Agent when AGENT_PLANNER=llm
 */
import { env } from '../config/env';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('LLM did not return JSON');
  }
}

export async function completeJSON(system: string, user: string): Promise<unknown> {
  if (env.aiProvider === 'gemini') {
    const data = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiKey}`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      },
    );
    return extractJson(data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '');
  }
  const data = await post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: env.openaiModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    { Authorization: `Bearer ${env.openaiKey}` },
  );
  return extractJson(data?.choices?.[0]?.message?.content ?? '');
}

/** Function-calling loop. Returns the list of tool calls the model made (max `maxSteps`). */
export async function runToolLoop(system: string, user: string, tools: ToolSpec[], exec: ToolExecutor, maxSteps = 5) {
  const calls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
  if (env.aiProvider === 'gemini') {
    const contents: any[] = [{ role: 'user', parts: [{ text: user }] }];
    for (let step = 0; step < maxSteps; step++) {
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiKey}`,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations: tools }],
          generationConfig: { temperature: 0.1 },
        },
      );
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const fc = parts.filter((p) => p.functionCall);
      if (!fc.length) break;
      contents.push({ role: 'model', parts });
      const responses = [];
      for (const p of fc) {
        const args = (p.functionCall.args ?? {}) as Record<string, unknown>;
        const result = await exec(p.functionCall.name, args);
        calls.push({ name: p.functionCall.name, args, result });
        responses.push({ functionResponse: { name: p.functionCall.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return calls;
  }
  const messages: any[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  for (let step = 0; step < maxSteps; step++) {
    const data = await post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: env.openaiModel,
        temperature: 0.1,
        messages,
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: 'auto',
      },
      { Authorization: `Bearer ${env.openaiKey}` },
    );
    const msg = data?.choices?.[0]?.message;
    if (!msg?.tool_calls?.length) break;
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* ignore */
      }
      const result = await exec(tc.function.name, args);
      calls.push({ name: tc.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return calls;
}
