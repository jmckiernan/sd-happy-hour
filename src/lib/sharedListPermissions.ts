export type ListMemberRole = 'editor' | 'viewer';
export type ListAccessRole = 'owner' | ListMemberRole;
export type ListSystemKey = 'favorites' | 'want_to_try' | 'been_to';

export interface ListAccess {
  role: ListAccessRole;
  isMember: boolean;
}

const ROLE_RANK: Record<ListAccessRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function isListMemberRole(value: unknown): value is ListMemberRole {
  return value === 'editor' || value === 'viewer';
}

export function strongestListRole(
  first: ListAccessRole | null | undefined,
  second: ListAccessRole | null | undefined
): ListAccessRole | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return ROLE_RANK[first] >= ROLE_RANK[second] ? first : second;
}

export function canViewList(access: ListAccess | null | undefined): boolean {
  return Boolean(access?.role);
}

// An invitation token can preview a list, but it is not an account-bound
// membership yet. Even an editor token must be accepted before it can write.
export function canEditList(access: ListAccess | null | undefined): boolean {
  return Boolean(access?.isMember && (access.role === 'owner' || access.role === 'editor'));
}

export function canManageListSharing(access: ListAccess | null | undefined): boolean {
  return Boolean(access?.isMember && access.role === 'owner');
}

export function isListSystemKey(value: unknown): value is ListSystemKey {
  return value === 'favorites' || value === 'want_to_try' || value === 'been_to';
}

export function isProtectedList(systemKey: unknown): boolean {
  return isListSystemKey(systemKey);
}

export function requiredRatingsSetting(
  systemKey: ListSystemKey | null,
  requested: unknown
): boolean {
  if (systemKey === 'favorites' || systemKey === 'been_to') return true;
  if (systemKey === 'want_to_try') return false;
  return requested === true;
}

export function mutuallyExclusiveSystemKey(
  systemKey: ListSystemKey | null | undefined
): ListSystemKey | null {
  if (systemKey === 'want_to_try') return 'been_to';
  if (systemKey === 'been_to') return 'want_to_try';
  return null;
}

export function venueAdditionDecision(input: {
  canEdit: boolean;
  alreadyIncluded: boolean;
  itemCount: number;
  maxItems: number;
}): 'add' | 'forbidden' | 'exists' | 'full' {
  if (!input.canEdit) return 'forbidden';
  if (input.alreadyIncluded) return 'exists';
  if (input.itemCount >= input.maxItems) return 'full';
  return 'add';
}

export function venueRemovalDecision(input: {
  canEdit: boolean;
  alreadyIncluded: boolean;
}): 'remove' | 'forbidden' | 'missing' {
  if (!input.canEdit) return 'forbidden';
  return input.alreadyIncluded ? 'remove' : 'missing';
}

export function cleanListTitle(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function cleanListDescription(value: unknown): string {
  return String(value ?? '').trim().slice(0, 500);
}
