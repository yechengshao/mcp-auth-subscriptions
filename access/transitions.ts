import type { AccessRow } from './model.js';

export type TransactionPhase = 'pending_identity' | 'identity_verified' | 'checkout_pending' | 'payment_pending' |
  'code_ready' | 'code_issued' | 'redeemed' | 'cancelled' | 'failed';

const next: Record<TransactionPhase, readonly TransactionPhase[]> = {
  pending_identity: ['identity_verified', 'cancelled'],
  identity_verified: ['checkout_pending', 'code_ready', 'failed'],
  checkout_pending: ['payment_pending', 'failed'],
  payment_pending: ['code_ready', 'failed'],
  code_ready: ['code_issued'],
  code_issued: ['redeemed'],
  redeemed: [],
  cancelled: [],
  failed: [],
};
const updates: Partial<Record<TransactionPhase, readonly string[]>> = {
  identity_verified: ['identity', 'subscriber_id'],
  checkout_pending: ['selected_offer'],
  payment_pending: ['order_id'],
};

/** Apply one legal transaction phase transition without permitting owner or callback rebinding. */
export function transitionTransaction(transaction: AccessRow, phase: TransactionPhase,
  patch: Record<string, unknown> = {}): AccessRow {
  const current = transaction.phase as TransactionPhase;
  if (!Object.hasOwn(next, current) || !next[current].includes(phase) ||
      !Number.isSafeInteger(transaction.revision) || Object.keys(patch).some(field => !updates[phase]?.includes(field))) {
    throw new Error('invalid_onboarding_transition');
  }
  if (phase === 'identity_verified' && (!patch.identity || typeof patch.identity !== 'object' ||
      typeof patch.subscriber_id !== 'string' || !patch.subscriber_id)) throw new Error('invalid_onboarding_transition');
  if (phase === 'checkout_pending' && (!patch.selected_offer || typeof patch.selected_offer !== 'object')) {
    throw new Error('invalid_onboarding_transition');
  }
  if (phase === 'payment_pending' && (typeof patch.order_id !== 'string' || !patch.order_id)) {
    throw new Error('invalid_onboarding_transition');
  }
  return { ...transaction, ...patch, phase, revision: transaction.revision + 1 };
}
