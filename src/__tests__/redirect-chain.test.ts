import { describe, it, expect } from "vitest";
import { RedirectChain } from "../resolver/redirect-chain.js";

describe("RedirectChain", () => {
  it("tracks hops correctly", () => {
    const chain = new RedirectChain();
    chain.add("https://a.com", 0);
    chain.add("https://b.com", 302);
    chain.add("https://c.com", 200);

    expect(chain.first).toBe("https://a.com");
    expect(chain.last).toBe("https://c.com");
    expect(chain.count).toBe(2);
  });

  it("detects loops", () => {
    const chain = new RedirectChain();
    chain.add("https://a.com", 0);
    chain.add("https://b.com", 302);
    chain.add("https://a.com", 302);

    expect(chain.hasLoop()).toBe(true);
  });

  it("reports no loop for linear chain", () => {
    const chain = new RedirectChain();
    chain.add("https://a.com", 0);
    chain.add("https://b.com", 302);
    chain.add("https://c.com", 200);

    expect(chain.hasLoop()).toBe(false);
  });

  it("formats chain as numbered list", () => {
    const chain = new RedirectChain();
    chain.add("https://a.com", 0);
    chain.add("https://b.com", 302);

    const formatted = chain.format();
    expect(formatted).toBe("1. https://a.com\n2. https://b.com");
  });

  it("returns 0 count for empty chain", () => {
    const chain = new RedirectChain();
    expect(chain.count).toBe(0);
    expect(chain.first).toBeUndefined();
    expect(chain.last).toBeUndefined();
  });
});
