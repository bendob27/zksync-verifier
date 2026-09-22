import OpenAI from 'openai';
import { logger } from './logger';
import type { OcrTransaction } from './types';

export function parseEuropeanNumber(str: string): number {
  if (typeof str === 'number') return str;
  if (!str || typeof str !== 'string') return 0;

  const cleaned = str.replace(/\s/g, '').trim();

  const hasCommaDecimal = /\.\d{3}[,.]|^\d{1,3}(\.\d{3})+,\d+$/.test(cleaned);

  if (hasCommaDecimal || (cleaned.includes('.') && cleaned.includes(',') && cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.'))) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return parseFloat(normalized) || 0;
  }

  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/\./g, '')) || 0;
  }

  return parseFloat(cleaned.replace(/,/g, '')) || 0;
}

export function isApiKeyAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

const OCR_PROMPT = `Extract all pending transactions from this custody platform screenshot. Each transaction shows: a date, the word 'Withdraw', an amount in European number format (dots for thousands, commas for decimals, e.g. 123.456,78 means 123456.78), the token name ZK_ZKSYNC, a source and destination wallet name, and a status like 'Needs approval'. For each transaction return JSON: { recipient: string (the destination wallet name after 'to'), amount: number (converted to standard decimal), date: string }. Return a JSON array of all transactions found.`;

export async function extractTransactionsFromScreenshots(
  imageBuffers: { buffer: Buffer; mimeType: string }[]
): Promise<{ transactions: OcrTransaction[]; rawText: string; confidence: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });
  const allTransactions: OcrTransaction[] = [];
  const allRawText: string[] = [];

  for (const image of imageBuffers) {
    try {
      const base64 = image.buffer.toString('base64');
      const mediaType = image.mimeType;

      const response = await client.chat.completions.create({
        model: 'anthropic/claude-opus-4-6',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${base64}`,
                },
              },
              {
                type: 'text',
                text: OCR_PROMPT,
              },
            ],
          },
        ],
      });

      const rawResponse = response.choices[0]?.message?.content;
      if (rawResponse) {
        allRawText.push(rawResponse);

        try {
          let parsed: unknown[] | null = null;

          // Attempt 1: Direct JSON.parse (clean JSON response)
          try {
            const direct = JSON.parse(rawResponse);
            if (Array.isArray(direct)) {
              parsed = direct;
            } else if (direct && typeof direct === 'object') {
              parsed = (direct as Record<string, unknown>).transactions as unknown[] || [direct];
            }
          } catch {
            // Not clean JSON — fall through to extraction
          }

          // Attempt 2: Find the last complete JSON array using bracket matching
          if (!parsed) {
            const lastBracket = rawResponse.lastIndexOf(']');
            if (lastBracket !== -1) {
              let depth = 0;
              let start = -1;
              for (let i = lastBracket; i >= 0; i--) {
                if (rawResponse[i] === ']') depth++;
                if (rawResponse[i] === '[') depth--;
                if (depth === 0) { start = i; break; }
              }
              if (start !== -1) {
                try {
                  const extracted = JSON.parse(rawResponse.substring(start, lastBracket + 1));
                  if (Array.isArray(extracted)) {
                    parsed = extracted;
                  }
                } catch {
                  // Fall through to object extraction
                }
              }
            }
          }

          // Attempt 3: Try to find a JSON object (single transaction)
          if (!parsed) {
            const objMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (objMatch) {
              const obj = JSON.parse(objMatch[0]);
              parsed = (obj as Record<string, unknown>).transactions as unknown[] || [obj];
            }
          }

          if (parsed) {
            for (const item of parsed) {
              const t = item as Record<string, unknown>;
              const rawAmount = t.amount;
              let amount: number;
              if (typeof rawAmount === 'string') {
                amount = parseEuropeanNumber(rawAmount);
              } else {
                amount = Number(rawAmount) || 0;
              }

              allTransactions.push({
                recipient: String(t.recipient || '').trim(),
                amount,
                date: t.date ? String(t.date).trim() : undefined,
              });
            }
          }
        } catch {
          logger.warn('Failed to parse OCR JSON response, using raw text');
        }
      }
    } catch (err) {
      logger.error({ err }, 'OCR extraction failed for image');
    }
  }

  return {
    transactions: allTransactions,
    rawText: allRawText.join('\n---\n'),
    confidence: allTransactions.length > 0 ? 0.85 : 0,
  };
}
