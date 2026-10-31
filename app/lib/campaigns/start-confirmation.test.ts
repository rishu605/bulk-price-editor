/**
 * The typed confirmation for a start nobody is watching (#1009): what a confirmation covers,
 * and when a start reaches further than it.
 */

import { describe, expect, it } from "vitest";

import { FLOW_ACTOR, SCHEDULER_ACTOR, startsUnattended } from "../audit/actor";
import type { BlastRadius } from "./blast-radius";
import { OWN_KEYS, ownRecordOf } from "./own-record";
import {
  beyondConfirmation,
  confirmationOf,
  confirmedReach,
  DEPTH_ALLOWANCE_BASIS_POINTS,
  START_CONFIRMED_KEY,
  startConfirmationOf,
  startConfirmationView,
  unconfirmedStart,
  withinCount,
  withStartConfirmed,
  type StartConfirmation,
} from "./start-confirmation";

const THRESHOLDS = { variants: 1_000, changePercent: 50 };

/** A preview's reach: none of the three reasons unless asked for. */
const radius = (over: Partial<BlastRadius> = {}): BlastRadius => ({
  thresholds: THRESHOLDS,
  planned: 8,
  largeChanges: 0,
  largest: null,
  atMinimum: 0,
  ...over,
});

/** 95% off, on `count` prices. */
const deep = (count: number, basisPoints = 9_500): BlastRadius =>
  radius({
    planned: count,
    largeChanges: count,
    largest: { title: "Wool coat", before: "$200.00", after: "$10.00", basisPoints, direction: "down" },
  });

const confirmed = (over: Partial<StartConfirmation> = {}): StartConfirmation => ({
  by: "staff:91614707946",
  at: "2026-10-15T09:00:00.000Z",
  planned: 8,
  largeChanges: 8,
  largestBasisPoints: 9_500,
  atMinimum: 0,
  ...over,
});

describe("a confirmation", () => {
  it("records who, when, and how far the campaign reached", () => {
    expect(confirmationOf(deep(8), "staff:91614707946", new Date("2026-10-15T09:00:00Z"))).toEqual(confirmed());
    // Nothing past the change threshold: no depth to record.
    expect(confirmationOf(radius({ planned: 1_200 }), "staff:1", new Date(0))).toMatchObject({
      planned: 1_200,
      largeChanges: 0,
      largestBasisPoints: 0,
    });
  });

  it("is kept in the schedule, replacing an earlier one, and read back", () => {
    const schedule = withStartConfirmed({ kind: "window", startAt: "2026-11-27T09:00:00Z" }, confirmed({ planned: 4 }));
    const again = withStartConfirmed(schedule, confirmed());
    expect(again).toMatchObject({ kind: "window", [START_CONFIRMED_KEY]: confirmed() });
    expect(startConfirmationOf(again)).toEqual(confirmed());
  });

  it("reads a stored value it cannot make sense of as no confirmation", () => {
    for (const stored of [undefined, null, {}, { by: "x" }, { ...confirmed(), planned: "8" }, { ...confirmed(), atMinimum: -1 }]) {
      expect(startConfirmationOf({ [START_CONFIRMED_KEY]: stored }), JSON.stringify(stored)).toBeNull();
    }
    expect(startConfirmationOf(null)).toBeNull();
  });

  it("stays when the dates move or it is unscheduled, and only it of the old blob (#1141)", () => {
    // About what the campaign writes, which dates do not change: the campaign's own record,
    // which an unschedule and new dates take forward by name. A copy, a new campaign nobody
    // confirmed, starts from `{ kind: "manual" }` -- pinned where Duplicate is tested.
    expect(OWN_KEYS).toContain(START_CONFIRMED_KEY);
    const schedule = withStartConfirmed(
      { kind: "window", startAt: "2026-11-27T09:00:00Z", zone: "Europe/London", startRefused: { reason: "No." } },
      confirmed(),
    );
    expect(ownRecordOf(schedule)).toEqual({ [START_CONFIRMED_KEY]: confirmed() });
    expect(startConfirmationOf({ ...ownRecordOf(schedule), kind: "manual" })).toEqual(confirmed());
  });

  it("is read out of nothing that is not a blob", () => {
    for (const blob of [null, undefined, "manual", 7, [START_CONFIRMED_KEY]]) expect(ownRecordOf(blob)).toEqual({});
  });
});

describe("what a confirmation covers", () => {
  it("lets a count grow by a tenth, and not at all under ten", () => {
    expect(withinCount(1_100, 1_000)).toBe(true);
    expect(withinCount(1_101, 1_000)).toBe(false);
    expect(withinCount(9, 9)).toBe(true);
    expect(withinCount(10, 9)).toBe(false);
    expect(withinCount(0, 0)).toBe(true);
    expect(withinCount(1, 0)).toBe(false);
  });

  it("covers the campaign it was given for, and one that shrank", () => {
    expect(beyondConfirmation(deep(8), confirmed())).toEqual([]);
    expect(beyondConfirmation(deep(3, 9_000), confirmed())).toEqual([]);
    expect(unconfirmedStart(deep(8), confirmed())).toBeNull();
  });

  it("covers a largest change a rounding away from the one confirmed, and not a point further", () => {
    expect(DEPTH_ALLOWANCE_BASIS_POINTS).toBe(100);
    expect(beyondConfirmation(deep(8, 9_600), confirmed())).toEqual([]);
    expect(beyondConfirmation(deep(8, 9_601), confirmed())).toEqual([
      "its largest change is now “Wool coat”, down 96%, and the largest confirmed was 95%",
    ]);
  });

  it("names each way a widened scope reaches further", () => {
    expect(beyondConfirmation(deep(8), confirmed({ planned: 4, largeChanges: 4 }))).toEqual([
      "it now writes 8 prices, and 4 were confirmed",
      "8 prices now move more than 50% from their baseline or land that far below cost, and 4 did when it was confirmed",
    ]);
  });

  it("names a reason that was not there when it was confirmed", () => {
    // Confirmed for its size alone; then its rule went deep.
    const sized = confirmed({ planned: 1_200, largeChanges: 0, largestBasisPoints: 0 });
    expect(beyondConfirmation({ ...deep(1_200), thresholds: THRESHOLDS }, sized)).toEqual([
      "1,200 prices now move more than 50% from their baseline or land that far below cost, and 0 did when it was confirmed",
      "its largest change is now “Wool coat”, down 95%, and no price moved that far when it was confirmed",
    ]);
    expect(beyondConfirmation(radius({ planned: 8, atMinimum: 8 }), confirmed({ atMinimum: 0 }))).toEqual([
      "8 prices would now reach zero or below, and 0 were confirmed",
    ]);
    // A handful at the smallest price never asks, confirmed or not.
    expect(beyondConfirmation(radius({ planned: 8, atMinimum: 5 }), confirmed({ atMinimum: 0 }))).toEqual([]);
  });
});

describe("a start that would discount a sale price again (#781)", () => {
  const compounding = { count: 1, title: "QA Recapture Board" };

  it("is never covered by a confirmation given before its baseline was recaptured", () => {
    expect(beyondConfirmation(radius({ compounding }), confirmed({ largeChanges: 0, largestBasisPoints: 0 }))).toEqual([
      "1 price it already set would now be discounted again, from a baseline recaptured at its sale price, and 0 were confirmed",
    ]);
    expect(unconfirmedStart(radius({ compounding }), null)).toMatch(/^“QA Recapture Board” already shows this campaign's price/);
  });

  it("is covered by one given over that, and records it", () => {
    const given = confirmationOf(radius({ compounding }), "staff:1", new Date(0));
    expect(given.compounding).toBe(1);
    expect(beyondConfirmation(radius({ compounding }), given)).toEqual([]);
    expect(confirmationOf(radius(), "staff:1", new Date(0))).not.toHaveProperty("compounding");
  });
});

describe("a start nobody is watching", () => {
  it("needs nothing when the preview does not ask for the word", () => {
    expect(unconfirmedStart(radius({ planned: 1_000 }), null)).toBeNull();
    expect(unconfirmedStart(radius({ atMinimum: 5 }), null)).toBeNull();
  });

  it("is refused unconfirmed, in the dialog's own sentences", () => {
    expect(unconfirmedStart(deep(8), null)).toBe(
      "8 prices move more than 50% from their baseline, or land that far below cost; the largest is “Wool coat”, down 95%. " +
        "Nobody has confirmed it by typing “apply”.",
    );
    expect(unconfirmedStart(radius({ planned: 1_001 }), null)).toMatch(/^This campaign writes 1,001 prices, more than the 1,000/);
  });

  it("is refused past its confirmation, naming who confirmed it and what grew, and never a price", () => {
    const said = unconfirmedStart(deep(20), confirmed());
    expect(said).toBe(
      "It reaches further than Staff 7946 confirmed: it now writes 20 prices, and 8 were confirmed; " +
        "20 prices now move more than 50% from their baseline or land that far below cost, and 8 did when it was confirmed.",
    );
    expect(said).not.toContain("$");
  });

  it("is the scheduler's and Flow's, and no person's", () => {
    expect(startsUnattended(SCHEDULER_ACTOR)).toBe(true);
    expect(startsUnattended(FLOW_ACTOR)).toBe(true);
    for (const actor of ["staff:91614707946", "shop.myshopify.com", "chaos"]) expect(startsUnattended(actor), actor).toBe(false);
  });
});

describe("what the campaign page says", () => {
  const at = (iso: string) => `at ${iso.slice(0, 10)}`;

  it("names the confirmation on record and what it covered", () => {
    expect(confirmedReach(confirmed({ atMinimum: 6 }))).toBe("8 prices; 8 past the change threshold, the largest 95%; 6 prices at the smallest price");
    expect(startConfirmationView(withStartConfirmed({}, confirmed()), deep(8), at)).toEqual({
      confirmed: { by: "Staff 7946", at: "at 2026-10-15", reach: "8 prices; 8 past the change threshold, the largest 95%" },
      unconfirmed: null,
    });
  });

  it("asks when the preview is not covered, and says nothing without a preview", () => {
    expect(startConfirmationView({}, deep(8), at).unconfirmed).toContain("Nobody has confirmed it");
    expect(startConfirmationView(withStartConfirmed({}, confirmed()), deep(20), at).unconfirmed).toMatch(/^It reaches further/);
    expect(startConfirmationView({}, undefined, at)).toEqual({ confirmed: null, unconfirmed: null });
  });
});
