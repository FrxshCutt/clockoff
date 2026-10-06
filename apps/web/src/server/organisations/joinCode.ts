/**
 * Company join codes (`WORD-####`, e.g. `BREW-4821`) for the organisations module.
 *
 * Thin adapter over the canonical generator in `@workmode/shared/joinCode` (curated word list, blocked
 * number list, uniform distribution). Kept as a module seam so tests can inject randomness.
 */
import {
  JOIN_CODE_REGEX,
  JOIN_CODE_WORDS,
  generateJoinCode,
  type RandomSource,
} from "@workmode/shared/joinCode";

export const JOIN_CODE_PATTERN = JOIN_CODE_REGEX;
export const JOIN_CODE_WORD_COUNT = JOIN_CODE_WORDS.length;

/** Generates a canonical join code. `random` returns a number in [0, 1); defaults to a CSPRNG. */
export function generateCompanyJoinCode(random?: RandomSource): string {
  return random ? generateJoinCode(random) : generateJoinCode();
}
