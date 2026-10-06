/**
 * Company join codes (`WORD-####`, e.g. `BREW-4821`) and employee invite codes (6 unambiguous characters).
 *
 * Join codes identify an organisation to the iOS join flow; one is ACTIVE per organisation at a time. They
 * are printed on posters, read aloud and typed on phones, so the word list avoids the letters I and O (which
 * read as 1 and 0), homophones and commonly misspelt words, the generator skips a few numbers with offensive
 * readings, and the invite-code alphabet has no vowels (so no words) and no 0/O/1/I look-alikes.
 *
 * Randomness comes from `globalThis.crypto.getRandomValues` (Web Crypto: Node 19+, browsers, edge runtimes).
 * Every generator accepts an injected `random: () => number` in [0, 1) so tests are deterministic.
 * Generators do not guarantee uniqueness: both codes are `@unique` in the database, so callers insert and
 * retry with a fresh code on a unique-constraint conflict.
 */

/**
 * ~200 friendly, unambiguous, uppercase 4–5 letter English words, grouped by first letter. Rules: everyday
 * nouns and adjectives only; no offensive, violent, drug (including slang such as GRASS, HERB, BLAZE),
 * tobacco, gambling, medical, religious or political words; no brand-first words (PUMA, CAMEL); no word whose
 * sound-alike is at least as common, so a code read aloud is typed the way it is printed (PEAR/PAIR,
 * BLUE/BLEW, SWEET/SUITE, BASE/BASS, MERRY/MARRY, CREEK/CREAK); no silent-letter spellings (THYME, WREN,
 * YACHT); no I or O. ~200 words × 10,000 numbers ≈ 2 million possible codes.
 */
export const JOIN_CODE_WORDS: readonly string[] = `
  ACRE ALPHA AMBER APEX APPLE AQUA ARCH ARENA ASPEN ATLAS
  BADGE BAGEL BAKE BANK BARN BATH BEACH BEAM BELL BELT BENCH BLEND BLUSH BRAVE BREAD BREW BRUSH
  BUNNY
  CABLE CAKE CALM CAMP CANAL CANDY CAPE CARD CART CAVE CEDAR CHALK CHART CHEER CHEF CHESS CLAY
  CLEAN CLEAR CRAFT CRANE CREAM CREST CREW CUBE CURVE CYCLE
  DANCE DART DAWN DEAL DECK DELTA DESK DREAM DRUM DUNE DUSK
  EAGLE EARTH EASEL EMBER
  FABLE FARM FEAST FERN FLAME FLASH FLEET FLUTE FRAME FRESH FUDGE
  GAME GATE GEAR GLAD GLASS GLAZE GLEAM GRACE GRAND GRAPE GREEN
  HAPPY HARP HATCH HAVEN HAWK HAZEL HEART
  JADE JAZZ JELLY JEWEL JUMP JUNE
  KALE KAYAK KELP
  LAKE LAMP LANE LARK LASER LATCH LATTE LAWN LEAF LEAP LEDGE LEMUR LEVEL LUCKY LUNAR LUNCH
  MAPLE MARCH MARSH MEAL METAL
  NAVY NEST NUDGE
  PALM PANDA PARK PARKA PASTA PATCH PEACH PEARL PECAN PLANK PLANT PLAZA PLUM PLUSH
  QUEEN QUEST
  RADAR RANCH RAVEN REEF RELAY RUBY
  SAFE SAGE SALSA SAND SCALE SCARF SEED SHADE SHAPE SHARK SHEEP SHELF SHELL SKATE SLATE SMART SNACK
  SPACE SPARK STAMP STAR STEAM STEP SUGAR SUNNY SURF SWAN SYRUP
  TABLE TEAM TENT THEME TRACK TRUCK TRUNK TUNA TUNE TURF
  ULTRA URBAN
  VALUE VAULT VERSE
  WATER WAVE WHEAT WHEEL
  YARN
  ZEBRA ZEST
`
  .trim()
  .split(/\s+/);

/** Canonical join code: 4–5 uppercase letters, a hyphen, 4 digits. Format only — list membership is not required. */
export const JOIN_CODE_REGEX = /^[A-Z]{4,5}-\d{4}$/;

/**
 * Four-digit numbers with well-known offensive or extremist readings. `generateJoinCode` never produces
 * them (it draws again); codes are printed on staff-room posters. Validation does not reject them, so codes
 * issued before an addition here stay usable.
 */
export const BLOCKED_JOIN_CODE_NUMBERS: ReadonlySet<string> = new Set([
  "0069",
  "0088",
  "0420",
  "0666",
  "1312",
  "1488",
  "6666",
  "6969",
]);

/**
 * Invite-code alphabet: consonants and the digits 2–9. No vowels (A, E, I, O, U, Y), so codes do not form
 * words (offensive or otherwise), and no 0/O or 1/I look-alikes. 28 symbols, so a 6-character code carries
 * about 28.8 bits (28^6 ≈ 481 million codes).
 */
export const INVITE_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_REGEX = /^[BCDFGHJ-NP-TV-XZ2-9]{6}$/;

/** Draws allowed for a non-blocked join-code number before giving up (≈ never reached with a real CSPRNG). */
const MAX_JOIN_CODE_NUMBER_DRAWS = 32;

/** Returns a float in [0, 1). */
export type RandomSource = () => number;

/** Uniform float in [0, 1) from the platform CSPRNG (53 bits of randomness). */
export function secureRandom(): number {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error(
      "Secure random source unavailable: globalThis.crypto.getRandomValues is missing",
    );
  }
  const buf = new Uint32Array(2);
  cryptoApi.getRandomValues(buf);
  const high = (buf[0] ?? 0) >>> 5; // 27 bits
  const low = (buf[1] ?? 0) >>> 6; // 26 bits
  return (high * 67108864 + low) / 9007199254740992; // (high * 2^26 + low) / 2^53
}

function randomInt(maxExclusive: number, random: RandomSource): number {
  const r = random();
  if (typeof r !== "number" || Number.isNaN(r) || r < 0 || r >= 1) {
    throw new RangeError(`random() must return a number in [0, 1); got ${String(r)}`);
  }
  return Math.min(maxExclusive - 1, Math.floor(r * maxExclusive));
}

/**
 * Generates a canonical join code such as `BREW-4821`. Consumes one value from `random` for the word and one
 * for the number, plus one more per number in `BLOCKED_JOIN_CODE_NUMBERS` drawn (redrawn, not skipped, so
 * the distribution stays uniform over the allowed numbers). Throws if `random` keeps producing blocked
 * numbers, which only a broken or constant source can do.
 */
export function generateJoinCode(random: RandomSource = secureRandom): string {
  const word = JOIN_CODE_WORDS[randomInt(JOIN_CODE_WORDS.length, random)];
  if (word === undefined) throw new Error("JOIN_CODE_WORDS is empty");
  for (let draw = 0; draw < MAX_JOIN_CODE_NUMBER_DRAWS; draw++) {
    const digits = String(randomInt(10_000, random)).padStart(4, "0");
    if (!BLOCKED_JOIN_CODE_NUMBERS.has(digits)) return `${word}-${digits}`;
  }
  throw new Error(
    `random() produced ${MAX_JOIN_CODE_NUMBER_DRAWS} blocked join-code numbers in a row; is it constant?`,
  );
}

/** True when `input` is already in canonical `WORD-####` form. Run `normaliseJoinCode` first on user input. */
export function isValidJoinCodeFormat(input: string): boolean {
  return JOIN_CODE_REGEX.test(input);
}

/**
 * Canonicalises typed input: trims, uppercases and drops separators, so `brew4821`, `brew 4821`, `BREW-4821`,
 * `brew_4821` and `brew—4821` (iOS smart punctuation) all become `BREW-4821`. Total function: input that
 * cannot be made canonical comes back uppercased with separators removed (e.g. `BREW48`), and
 * `isValidJoinCodeFormat` on the result returns false.
 */
export function normaliseJoinCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const match = /^([A-Z]{4,5})(\d{4})$/.exec(compact);
  return match ? `${match[1]}-${match[2]}` : compact;
}

/** 6-character employee invite code from the vowel-free alphabet, e.g. `K7PX2M`. Consumes six values from `random`. */
export function generateEmployeeInviteCode(random: RandomSource = secureRandom): string {
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_CODE_ALPHABET.charAt(randomInt(INVITE_CODE_ALPHABET.length, random));
  }
  return out;
}

/** Trims, uppercases and drops separators so `k7p-x2m` and `k7p x2m` become `K7PX2M`. Total function. */
export function normaliseInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** True when `input` is a canonical invite code. Run `normaliseInviteCode` first on user input. */
export function isValidInviteCodeFormat(input: string): boolean {
  return INVITE_CODE_REGEX.test(input);
}
