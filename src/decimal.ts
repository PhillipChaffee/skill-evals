const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads the value of a numeric flag. Unlike `Number`, it takes plain decimal text only.
 * @param text - What follows the flag.
 * @returns The number; NaN for empty or blank text, hexadecimal, and anything else that is not a decimal number.
 */
export const readDecimal = (text: string): number =>
  DECIMAL.test(text) ? Number(text) : NaN;
