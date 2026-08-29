export function isAnthropicBillingError(errorOrText) {
  const text = String(errorOrText?.message || errorOrText || '');
  return /credit balance is too low|purchase credits/i.test(text);
}

export class AnthropicBillingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnthropicBillingError';
  }
}
