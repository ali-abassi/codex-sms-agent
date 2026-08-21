/** E.164 as Sendblue accepts it: + country code, 8 to 15 digits total. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}
