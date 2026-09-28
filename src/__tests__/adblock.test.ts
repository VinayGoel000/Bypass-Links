import { describe, it, expect } from "vitest";
import { isAdUrl } from "../bypass/adblock.js";

describe("isAdUrl", () => {
  it("flags known ad / popup / tracker domains", () => {
    expect(isAdUrl("https://www.doubleclick.net/ads")).toBe(true);
    expect(isAdUrl("https://pagead2.googlesyndication.com/pagead/js/ads.js")).toBe(true);
    expect(isAdUrl("https://googleadservices.com/pagead/aclk")).toBe(true);
    expect(isAdUrl("https://c1.adsterra.com/script.js")).toBe(true);
    expect(isAdUrl("https://www.popads.net/pop.js")).toBe(true);
    expect(isAdUrl("https://popcash.net/")).toBe(true);
    expect(isAdUrl("https://propellerads.com/x")).toBe(true);
    expect(isAdUrl("https://exoclick.com/a")).toBe(true);
    expect(isAdUrl("https://clickadu.com/b")).toBe(true);
    expect(isAdUrl("https://taboola.com/c")).toBe(true);
    expect(isAdUrl("https://www.google-analytics.com/g/collect")).toBe(true);
  });

  it("does not flag normal shortener / destination domains", () => {
    expect(isAdUrl("https://arolinks.com/xyz")).toBe(false);
    expect(isAdUrl("https://gplinks.in/abc")).toBe(false);
    expect(isAdUrl("https://ouo.io/press")).toBe(false);
    expect(isAdUrl("https://drive.google.com/file/d/123")).toBe(false);
    expect(isAdUrl("https://example.com/page")).toBe(false);
  });

  it("handles garbage input without throwing", () => {
    expect(isAdUrl("")).toBe(false);
    expect(isAdUrl("not a url")).toBe(false);
    expect(isAdUrl("about:blank")).toBe(false);
  });
});
