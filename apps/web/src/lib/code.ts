/** The authenticator code: six digits (M62/M63). */
export const validCode = (code: string): boolean => /^\d{6}$/.test(code);
