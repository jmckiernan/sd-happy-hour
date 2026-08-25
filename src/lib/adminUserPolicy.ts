export type AccountStatus = 'active' | 'inactive' | 'anonymized';
export type AdminAccountAction = 'deactivate' | 'reactivate' | 'anonymize';

export interface AccountMutationSubject {
  id: string;
  email: string;
  accountStatus: AccountStatus;
}

export type AccountMutationDecision =
  | 'allowed'
  | 'self'
  | 'protected_admin'
  | 'already_anonymized'
  | 'invalid_transition';

export function accountMutationDecision(input: {
  actor: AccountMutationSubject;
  target: AccountMutationSubject;
  action: AdminAccountAction;
  adminEmails: readonly string[];
}): AccountMutationDecision {
  const { actor, target, action } = input;
  if (actor.id === target.id) return 'self';
  if (input.adminEmails.some((email) => email.toLowerCase() === target.email.toLowerCase())) {
    return 'protected_admin';
  }
  if (target.accountStatus === 'anonymized') return 'already_anonymized';
  if (action === 'deactivate' && target.accountStatus !== 'active') return 'invalid_transition';
  if (action === 'reactivate' && target.accountStatus !== 'inactive') return 'invalid_transition';
  return 'allowed';
}

export function requiresOwnershipTransfer(input: {
  verifiedVenueClaims: number;
  customOwnedLists: number;
}): boolean {
  return input.verifiedVenueClaims > 0 || input.customOwnedLists > 0;
}

export function averageSessionSeconds(activeSeconds: number, sessionCount: number): number {
  if (!Number.isFinite(activeSeconds) || !Number.isFinite(sessionCount) || sessionCount <= 0) return 0;
  return Math.max(0, Math.round(activeSeconds / sessionCount));
}

export function normalizeReportingDays(value: unknown): 7 | 30 | 90 {
  const days = Number(value);
  return days === 7 || days === 90 ? days : 30;
}

