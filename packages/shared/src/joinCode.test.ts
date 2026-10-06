import { describe, expect, it } from "vitest";
import {
  BLOCKED_JOIN_CODE_NUMBERS,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_REGEX,
  JOIN_CODE_REGEX,
  JOIN_CODE_WORDS,
  generateEmployeeInviteCode,
  generateJoinCode,
  isValidInviteCodeFormat,
  isValidJoinCodeFormat,
  normaliseInviteCode,
  normaliseJoinCode,
  secureRandom,
} from "./joinCode";

/** Deterministic random source that replays the given values (then 0). */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe("JOIN_CODE_WORDS", () => {
  it("has roughly 200 unique words", () => {
    expect(JOIN_CODE_WORDS.length).toBeGreaterThanOrEqual(200);
    expect(JOIN_CODE_WORDS.length).toBeLessThanOrEqual(260);
    expect(new Set(JOIN_CODE_WORDS).size).toBe(JOIN_CODE_WORDS.length);
  });

  it("every word is 4–5 uppercase letters with no I or O", () => {
    for (const w of JOIN_CODE_WORDS) expect(w, w).toMatch(/^[A-HJ-NP-Z]{4,5}$/);
  });

  it("is sorted alphabetically (keeps review and diffs easy)", () => {
    expect([...JOIN_CODE_WORDS]).toEqual([...JOIN_CODE_WORDS].sort());
  });

  it("every word matches the canonical code format", () => {
    for (const w of JOIN_CODE_WORDS) expect(isValidJoinCodeFormat(`${w}-1234`), w).toBe(true);
  });

  it("contains none of a deny-list of unfriendly, risky or easily mistyped words", () => {
    const deny = [
      // violent / unpleasant
      "DEATH",
      "KILL",
      "BLADE",
      "SPEAR",
      "GUNS",
      "BLEED",
      "DEAD",
      "WAR",
      "BOMB",
      "HATE",
      "DAMN",
      "HELL",
      // drugs (incl. slang) / tobacco / gambling / medical / religious / political / crude slang
      "SPEED",
      "WEED",
      "GRASS",
      "HERB",
      "BLAZE",
      "HIGH",
      "CAMEL",
      "CLAP",
      "BET",
      "BETS",
      "POKER",
      "DRUG",
      "PILL",
      "ANGEL",
      "PRAY",
      "VOTE",
      "PARTY",
      // homophones / spelling traps
      "GREY",
      "GRAY",
      "PEAR",
      "PAIR",
      "BEAR",
      "BARE",
      "STEEL",
      "STEAL",
      "BLUE",
      "BLEW",
      "THYME",
      "WREN",
      "YACHT",
      "RHYME",
      "WHALE",
      "LAMB",
      "CRUMB",
      "LLAMA",
      "PLANE",
      "BERRY",
      "SWEET", // suite
      "BASE", // bass
      "MERRY", // marry
      "PETAL", // pedal
      "BEAN", // been
      "CREEK", // creak
      "MAZE", // maize
      // brands
      "PUMA",
      "NIKE",
    ];
    for (const w of deny) expect(JOIN_CODE_WORDS.includes(w), w).toBe(false);
  });
});

describe("generateJoinCode", () => {
  it("formats as WORD-#### and is deterministic for an injected random source", () => {
    expect(generateJoinCode(sequence(0, 0))).toBe(`${JOIN_CODE_WORDS[0]}-0000`);
    expect(generateJoinCode(sequence(0.999999999, 0.99999999))).toBe(
      `${JOIN_CODE_WORDS[JOIN_CODE_WORDS.length - 1]}-9999`,
    );
    const brew = JOIN_CODE_WORDS.indexOf("BREW");
    expect(brew).toBeGreaterThanOrEqual(0);
    expect(generateJoinCode(sequence((brew + 0.5) / JOIN_CODE_WORDS.length, 0.48215))).toBe(
      "BREW-4821",
    );
  });

  it("never yields a blocked number: it draws again, consuming one more value", () => {
    expect(BLOCKED_JOIN_CODE_NUMBERS.size).toBeGreaterThan(0);
    for (const blocked of BLOCKED_JOIN_CODE_NUMBERS) {
      expect(blocked).toMatch(/^\d{4}$/);
      const asFraction = (Number(blocked) + 0.5) / 10_000;
      expect(generateJoinCode(sequence(0, asFraction, 0.48215))).toBe(`${JOIN_CODE_WORDS[0]}-4821`);
    }
    expect(generateJoinCode(sequence(0, 0.14885, 0.06665, 0.0001))).toBe(
      `${JOIN_CODE_WORDS[0]}-0001`,
    );
  });

  it("throws instead of looping forever on a constant source stuck on a blocked number", () => {
    expect(() => generateJoinCode(() => 0.14885)).toThrow(/blocked join-code numbers/);
  });

  it("blocked numbers are still accepted by validation (codes issued earlier stay usable)", () => {
    for (const blocked of BLOCKED_JOIN_CODE_NUMBERS)
      expect(isValidJoinCodeFormat(`BREW-${blocked}`)).toBe(true);
  });

  it("zero-pads the digits", () => {
    expect(generateJoinCode(sequence(0, 0.0007))).toMatch(/-0007$/);
    expect(generateJoinCode(sequence(0, 0.00005))).toMatch(/-0000$/);
  });

  it("uses the secure default source and always yields a valid, listed code", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(JOIN_CODE_REGEX);
      expect(JOIN_CODE_WORDS).toContain(code.split("-")[0]);
    }
  });

  it("spreads over the word list (not stuck on one word)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateJoinCode().split("-")[0] ?? "");
    expect(seen.size).toBeGreaterThan(100);
  });

  it("rejects random sources outside [0, 1)", () => {
    expect(() => generateJoinCode(() => 1)).toThrow(RangeError);
    expect(() => generateJoinCode(() => -0.1)).toThrow(RangeError);
    expect(() => generateJoinCode(() => Number.NaN)).toThrow(RangeError);
  });
});

describe("secureRandom", () => {
  it("returns values in [0, 1) that are not constant", () => {
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const r = secureRandom();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      values.add(r);
    }
    expect(values.size).toBeGreaterThan(990);
  });
});

describe("isValidJoinCodeFormat", () => {
  it.each([
    ["BREW-4821", true],
    ["ATLAS-0001", true],
    ["brew-4821", false],
    ["BREW4821", false],
    ["BREW-482", false],
    ["BREW-48211", false],
    ["BRE-4821", false],
    ["BREWED-4821", false],
    ["BREW-ABCD", false],
    [" BREW-4821", false],
    ["BREW-4821\n", false],
    ["", false],
  ])("%j → %s", (input, expected) => {
    expect(isValidJoinCodeFormat(input)).toBe(expected);
  });
});

describe("normaliseJoinCode", () => {
  it.each([
    ["BREW-4821", "BREW-4821"],
    ["brew-4821", "BREW-4821"],
    ["brew4821", "BREW-4821"],
    ["brew 4821", "BREW-4821"],
    ["  brew   4821 ", "BREW-4821"],
    ["brew_4821", "BREW-4821"],
    ["brew--4821", "BREW-4821"],
    ["brew.4821", "BREW-4821"],
    ["brew—4821", "BREW-4821"], // em dash from iOS smart punctuation
    ["brew–4821", "BREW-4821"], // en dash
    ["Brew - 4821", "BREW-4821"],
    ["\tbrew-4821\n", "BREW-4821"],
    ["atlas 1234", "ATLAS-1234"],
    ["brew 48", "BREW48"],
    ["brew-48215", "BREW48215"],
    ["4821 brew", "4821BREW"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(normaliseJoinCode(input)).toBe(expected);
  });

  it("composes with isValidJoinCodeFormat for user input", () => {
    expect(isValidJoinCodeFormat(normaliseJoinCode("brew 4821"))).toBe(true);
    expect(isValidJoinCodeFormat(normaliseJoinCode("brew 48"))).toBe(false);
  });

  it("is idempotent and round-trips generated codes", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateJoinCode();
      expect(normaliseJoinCode(code)).toBe(code);
      expect(normaliseJoinCode(code.toLowerCase().replace("-", " "))).toBe(code);
      expect(normaliseJoinCode(code.replace("-", ""))).toBe(code);
    }
  });
});

describe("invite codes", () => {
  it("alphabet has 28 unique symbols: no vowels (no words) and no 0/O/1/I look-alikes", () => {
    expect(INVITE_CODE_ALPHABET).toHaveLength(28);
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(28);
    for (const c of "AEIOUY01") expect(INVITE_CODE_ALPHABET.includes(c), c).toBe(false);
    for (const c of INVITE_CODE_ALPHABET) expect(c).toMatch(/^[B-DF-HJ-NP-TV-XZ2-9]$/);
  });

  it("INVITE_CODE_REGEX accepts exactly the alphabet", () => {
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      expect(INVITE_CODE_REGEX.test(c.repeat(6)), c).toBe(INVITE_CODE_ALPHABET.includes(c));
    }
  });

  it("generates 6 characters from the alphabet, deterministically for an injected source", () => {
    expect(generateEmployeeInviteCode(sequence(0, 0, 0, 0, 0, 0))).toBe("BBBBBB");
    expect(generateEmployeeInviteCode(sequence(0.99, 0.99, 0.99, 0.99, 0.99, 0.99))).toBe("999999");
    expect(generateEmployeeInviteCode(sequence(0, 1 / 28, 2 / 28, 3 / 28, 4 / 28, 5 / 28))).toBe(
      "BCDFGH",
    );
  });

  it("default source yields valid, varied codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = generateEmployeeInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(code).toMatch(INVITE_CODE_REGEX);
      expect(isValidInviteCodeFormat(code)).toBe(true);
      expect(code).not.toMatch(/[AEIOUY]/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(295);
  });

  it("rejects random sources outside [0, 1)", () => {
    expect(() => generateEmployeeInviteCode(() => 1)).toThrow(RangeError);
  });

  it.each([
    ["k7px2m", "K7PX2M"],
    [" K7P X2M ", "K7PX2M"],
    ["k7p-x2m", "K7PX2M"],
    ["K7P_X2M", "K7PX2M"],
    ["k7p—x2m", "K7PX2M"],
    ["", ""],
  ])("normaliseInviteCode(%j) → %j", (input, expected) => {
    expect(normaliseInviteCode(input)).toBe(expected);
  });

  it.each([
    ["K7PX2M", true],
    ["BCDFGH", true],
    ["234567", true],
    ["ABCDEF", false], // vowels are not in the alphabet
    ["K7PXUM", false],
    ["K7PXYM", false],
    ["K7PX2", false],
    ["K7PX2MM", false],
    ["K7PX0M", false],
    ["K7PXOM", false],
    ["K7PX1M", false],
    ["K7PXIM", false],
    ["k7px2m", false],
  ])("isValidInviteCodeFormat(%s) → %s", (input, expected) => {
    expect(isValidInviteCodeFormat(input)).toBe(expected);
  });
});
