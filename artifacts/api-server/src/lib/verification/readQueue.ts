/**
 * Reading the custody queue from screenshots.
 *
 * Each image is read separately and its outcome recorded separately, so one unreadable
 * image is reported as a gap in the evidence rather than disappearing. That is what stops
 * a partial read from looking like a completed reconciliation.
 */

import { logger } from '../logger';
import { OPENROUTER_MODEL } from '../constants';
import type { ScreenshotReader } from './run';

const REQUEST_TIMEOUT_MS = 60_000;

const PROMPT = [
  'Extract every pending transaction visible in this custody platform screenshot.',
  'Each row shows a date, an amount, a token name, a source and destination wallet name,',
  'and a status.',
  '',
  'Amounts may use either decimal convention. Return the amount EXACTLY as printed, as a',
  'string, without reformatting it — do not convert separators and do not round.',
  '',
  'Return only a JSON array:',
  '[{"recipient": "destination wallet name", "amount": "as printed", "date": "as printed"}]',
  'Return [] if the image shows no transactions.',
].join('\n');

export const readCustodyScreenshots: ScreenshotReader = async (images) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });

  const lines: Array<{ recipient: string; amount: unknown; date?: unknown; sourceRef: string }> = [];
  const failures: Array<{ sourceRef: string; reason: string }> = [];

  const reads = await Promise.all(images.map(async (image, i) => {
    const sourceRef = `screenshot ${i + 1}`;
    try {
      const response = await client.chat.completions.create({
        model: OPENROUTER_MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` } },
          ],
        }],
      });

      const choice = response.choices[0];
      if (choice?.finish_reason === 'length') {
        return { sourceRef, error: 'the reading was cut off before it finished' };
      }
      const raw = choice?.message?.content;
      if (!raw) return { sourceRef, error: 'no content was returned for this image' };

      const match = /\[[\s\S]*\]/.exec(raw);
      if (!match) return { sourceRef, error: 'the reading was not valid JSON' };

      const parsed = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(parsed)) return { sourceRef, error: 'the reading was not a list of transactions' };

      return { sourceRef, rows: parsed as Array<Record<string, unknown>> };
    } catch (err) {
      return { sourceRef, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }));

  for (const read of reads) {
    if ('error' in read && read.error) {
      failures.push({ sourceRef: read.sourceRef, reason: read.error });
      continue;
    }
    for (const r of read.rows ?? []) {
      const recipient = String(r.recipient ?? '').trim();
      if (recipient === '') {
        failures.push({ sourceRef: read.sourceRef, reason: 'a transaction had no recipient' });
        continue;
      }
      lines.push({ recipient, amount: r.amount, date: r.date, sourceRef: read.sourceRef });
    }
  }

  logger.info({ images: images.length, lines: lines.length, failures: failures.length }, 'custody queue read');
  return { lines, failures };
};
