import { compile, epoch, term as termSchema } from './schemas.js';
import type { Term } from './validate.js';
const validateTerm = compile(termSchema);
const validateEpoch = compile(epoch);
/** Exclusive expiry from verified payment time; no provider/network calls. */
export function termExpiry(paymentEpoch: number, input: unknown): number {
  validateEpoch(paymentEpoch); validateTerm(input);
  const term = input as Term;
  if (term.unit === 'day') {
    const result = paymentEpoch + term.count * 86400;
    validateEpoch(result);
    return result;
  }
  const start = new Date(paymentEpoch * 1000);
  const originalDay = start.getUTCDate();
  const target = new Date(start);
  target.setUTCDate(1);
  if (term.unit === 'month') target.setUTCMonth(target.getUTCMonth() + term.count);
  else target.setUTCFullYear(target.getUTCFullYear() + term.count);
  const last = new Date(target);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(originalDay, last.getUTCDate()));
  const result = target.getTime() / 1000;
  validateEpoch(result);
  return result;
}
