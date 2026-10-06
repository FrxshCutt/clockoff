import { describe, expect, it } from "vitest";
import {
  buildRecurrenceRule,
  describeRecurrenceRule,
  normaliseWeekdays,
  recurrenceOptionsFromRule,
} from "./rrule-builder";

describe("buildRecurrenceRule", () => {
  it("returns no rule for 'does not repeat' and FREQ=DAILY for daily", () => {
    expect(buildRecurrenceRule({ repeat: "none", weekdays: [], customRule: "" })).toEqual({
      ok: true,
      rule: null,
    });
    expect(buildRecurrenceRule({ repeat: "daily", weekdays: ["MO"], customRule: "junk" })).toEqual({
      ok: true,
      rule: "FREQ=DAILY",
    });
  });

  it("builds a weekly rule from the selected weekdays in Monday-first order without duplicates", () => {
    expect(
      buildRecurrenceRule({ repeat: "weekly", weekdays: ["FR", "MO", "FR", "WE"], customRule: "" }),
    ).toEqual({ ok: true, rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" });
    expect(buildRecurrenceRule({ repeat: "weekly", weekdays: [], customRule: "" })).toEqual({
      ok: false,
      error: "Choose at least one weekday",
    });
    expect(normaliseWeekdays(["SU", "SA", "SU"])).toEqual(["SA", "SU"]);
  });

  it("validates and normalises a custom rule with the shared parser", () => {
    expect(
      buildRecurrenceRule({
        repeat: "custom",
        weekdays: [],
        customRule: "RRULE:freq=weekly;byday=mo,tu;interval=2",
      }),
    ).toEqual({
      ok: true,
      rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU",
    });
    expect(
      buildRecurrenceRule({ repeat: "custom", weekdays: [], customRule: "FREQ=MONTHLY;BYDAY=1MO" }),
    ).toEqual({ ok: true, rule: "FREQ=MONTHLY;BYDAY=1MO" });
  });

  it("rejects empty, UNTIL/COUNT and unsupported custom rules", () => {
    expect(buildRecurrenceRule({ repeat: "custom", weekdays: [], customRule: "   " }).ok).toBe(
      false,
    );
    const until = buildRecurrenceRule({
      repeat: "custom",
      weekdays: [],
      customRule: "FREQ=DAILY;UNTIL=20261231T000000Z",
    });
    expect(until.ok).toBe(false);
    if (!until.ok) expect(until.error).toMatch(/Repeat until/);
    const count = buildRecurrenceRule({
      repeat: "custom",
      weekdays: [],
      customRule: "FREQ=DAILY;COUNT=5",
    });
    expect(count.ok).toBe(false);
    expect(
      buildRecurrenceRule({ repeat: "custom", weekdays: [], customRule: "FREQ=HOURLY" }).ok,
    ).toBe(false);
    expect(
      buildRecurrenceRule({ repeat: "custom", weekdays: [], customRule: "not a rule" }).ok,
    ).toBe(false);
  });
});

describe("recurrenceOptionsFromRule", () => {
  it("recognises the simple daily and weekly forms", () => {
    expect(recurrenceOptionsFromRule(null)).toEqual({
      repeat: "none",
      weekdays: [],
      customRule: "",
    });
    expect(recurrenceOptionsFromRule("FREQ=DAILY")).toEqual({
      repeat: "daily",
      weekdays: [],
      customRule: "",
    });
    expect(recurrenceOptionsFromRule("FREQ=WEEKLY;BYDAY=FR,MO")).toEqual({
      repeat: "weekly",
      weekdays: ["MO", "FR"],
      customRule: "",
    });
  });

  it("falls back to custom for anything else, keeping the canonical text", () => {
    expect(recurrenceOptionsFromRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")).toEqual({
      repeat: "custom",
      weekdays: [],
      customRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    });
    expect(recurrenceOptionsFromRule("FREQ=WEEKLY")).toEqual({
      repeat: "custom",
      weekdays: [],
      customRule: "FREQ=WEEKLY",
    });
    expect(recurrenceOptionsFromRule("garbage")).toEqual({
      repeat: "custom",
      weekdays: [],
      customRule: "garbage",
    });
  });

  it("round-trips what the builder produces", () => {
    for (const options of [
      { repeat: "daily" as const, weekdays: [], customRule: "" },
      { repeat: "weekly" as const, weekdays: ["TU", "TH"] as const, customRule: "" },
      { repeat: "custom" as const, weekdays: [], customRule: "FREQ=MONTHLY;BYMONTHDAY=1" },
    ]) {
      const built = buildRecurrenceRule(options);
      expect(built.ok).toBe(true);
      if (built.ok)
        expect(recurrenceOptionsFromRule(built.rule)).toEqual({
          ...options,
          weekdays: [...options.weekdays],
        });
    }
  });
});

describe("describeRecurrenceRule", () => {
  it("explains common rules in plain English", () => {
    expect(describeRecurrenceRule(null)).toBeNull();
    expect(describeRecurrenceRule("FREQ=DAILY")).toBe("Every day");
    expect(describeRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,WE")).toBe("Every week on Mon, Wed");
    expect(describeRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe("Every 2 weeks on Fri");
    expect(describeRecurrenceRule("FREQ=MONTHLY")).toBe("Every month");
  });

  it("falls back to the rule text for exotic or invalid rules", () => {
    expect(describeRecurrenceRule("FREQ=MONTHLY;BYDAY=-1FR")).toBe("FREQ=MONTHLY;BYDAY=-1FR");
    expect(describeRecurrenceRule("nonsense")).toBe("nonsense");
  });
});
