const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads the value of a numeric flag. Unlike `Number`, it takes a decimal literal only. Surrounding whitespace is
 * trimmed, as it was in 0.0.1.
 * @param text - What follows the flag.
 * @returns The number; NaN for empty or blank text, hexadecimal, binary and octal, `Infinity`, and anything else that
 *   is not a decimal number.
 */
export const readDecimal = (text: string): number => {
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : NaN;
};
