/**
 * The identity proposer, backed by a language model.
 *
 * It is asked one question and may answer only with a row id we supplied. It is never
 * shown, and never asked for, an amount, a date or a cap — those are read from the
 * schedule in code. Validation of the answer happens in resolve.ts, not here.
 */

import OpenAI from 'openai';
import { logger } from '../logger';
import { OPENROUTER_MODEL } from '../constants';
import type { ProposeFn, ResolverProposal } from './resolve';

const REQUEST_TIMEOUT_MS = 90_000;

export const proposeWithModel: ProposeFn = async ({ payments, offers }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  });

  const prompt = [
    'You are matching payment rows to rows of a grant schedule.',
    '',
    'For each payment below, decide which schedule row it refers to. Grant references are',
    'not always written identically (for example "ACM001", "ACM-001" and "ACM 001" may all',
    'mean the same grant), and sometimes the reference is wrong but the recipient name',
    'identifies the grant.',
    '',
    'Answer ONLY with a rowId taken from the SCHEDULE ROWS list. If you are not confident,',
    'return null for that payment. Never invent a rowId. Do not return amounts or dates.',
    '',
    'PAYMENTS:',
    JSON.stringify(payments, null, 1),
    '',
    'SCHEDULE ROWS:',
    JSON.stringify(offers, null, 1),
    '',
    'Return a JSON array, exactly one entry per payment:',
    '[{"paymentId": "...", "rowId": "..." | null, "reason": "short explanation"}]',
  ].join('\n');

  const response = await client.chat.completions.create({
    model: OPENROUTER_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const choice = response.choices[0];
  if (choice?.finish_reason === 'length') {
    // A truncated answer may be missing rows. Say so rather than using a partial list.
    throw new Error('the matching response was cut off before it finished');
  }

  const raw = choice?.message?.content;
  if (!raw) throw new Error('the matching service returned no content');

  const parsed = extractJsonArray(raw);
  if (!parsed) throw new Error('the matching response was not valid JSON');

  logger.info({ requested: payments.length, returned: parsed.length }, 'identity proposals received');

  return parsed
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map<ResolverProposal>((p) => ({
      paymentId: String(p.paymentId ?? ''),
      rowId: typeof p.rowId === 'string' ? p.rowId : null,
      reason: typeof p.reason === 'string' ? p.reason : undefined,
    }));
};

/**
 * Pull a JSON array out of a reply that may be wrapped in prose or a code fence.
 * String-aware, so a bracket inside a reason field cannot truncate the parse.
 */
function extractJsonArray(text: string): unknown[] | null {
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return direct;
  } catch { /* fall through */ }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const candidate = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(candidate)) return candidate;
        } catch { /* keep looking */ }
        start = -1;
      }
    }
  }
  return null;
}
