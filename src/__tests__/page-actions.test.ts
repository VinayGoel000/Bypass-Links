import { describe, it, expect } from "vitest";
import {
  matchesActionText,
  isTimerDoneText,
  isTimerElementDone,
  ACTION_TEXT_PATTERNS,
} from "../bypass/page-actions.js";

describe("matchesActionText", () => {
  it("matches get-link variants", () => {
    expect(matchesActionText("Get Link")).toBe(true);
    expect(matchesActionText("GET LINK")).toBe(true);
    expect(matchesActionText("Get Your Link")).toBe(true);
    expect(matchesActionText("  get   link  ")).toBe(true);
  });

  it("matches continue / proceed / unlock variants", () => {
    expect(matchesActionText("Continue")).toBe(true);
    expect(matchesActionText("Continue to Link")).toBe(true);
    expect(matchesActionText("Click here to continue")).toBe(true);
    expect(matchesActionText("Proceed")).toBe(true);
    expect(matchesActionText("Unlock Link")).toBe(true);
    expect(matchesActionText("Unlock My Link")).toBe(true);
    expect(matchesActionText("Download Link")).toBe(true);
    expect(matchesActionText("Verify & Continue")).toBe(true);
  });

  it("rejects non-action text", () => {
    expect(matchesActionText("")).toBe(false);
    expect(matchesActionText("Advertisement")).toBe(false);
    expect(matchesActionText("Click here to win a prize")).toBe(false);
    expect(matchesActionText("Get Links Free Money")).toBe(false);
    expect(matchesActionText("Continue reading")).toBe(false);
  });

  it("exports valid regex sources", () => {
    for (const p of ACTION_TEXT_PATTERNS) {
      expect(() => new RegExp(p, "i")).not.toThrow();
    }
  });
});

describe("isTimerDoneText", () => {
  it("detects timer-finished phrases", () => {
    expect(isTimerDoneText("Your timer is complete, click below")).toBe(true);
    expect(isTimerDoneText("Link is ready!")).toBe(true);
    expect(isTimerDoneText("Please wait 10 seconds")).toBe(false);
  });
});

describe("isTimerElementDone", () => {
  it("detects zeroed / finished countdowns", () => {
    expect(isTimerElementDone("0")).toBe(true);
    expect(isTimerElementDone("00")).toBe(true);
    expect(isTimerElementDone("0 seconds")).toBe(true);
    expect(isTimerElementDone("Timer complete")).toBe(true);
    expect(isTimerElementDone("10")).toBe(false);
    expect(isTimerElementDone("Please wait 5 seconds")).toBe(false);
    expect(isTimerElementDone("")).toBe(false);
  });
});
