import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.BOT_TOKEN = "123456:TESTTOKEN";

vi.mock("../security/ssrf-protection.js", () => ({
  resolveAndValidate: vi.fn().mockResolvedValue({ safe: true, resolvedIp: "93.184.216.34" }),
}));

import { followHtmlHops } from "../bypass/html-hops.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function htmlPage(body: string): string {
  return `<html><head></head><body>${body}</body></html>`;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("followHtmlHops", () => {
  it("follows a multi-hop chain to the deepest URL", async () => {
    const pages: Record<string, string> = {
      "https://hop1.example/": htmlPage(`<script>var next = "https://hop2.example/step2";</script>`),
      "https://hop2.example/step2": htmlPage(
        `<script>window.location = "https://final.example/done";</script>`
      ),
      "https://final.example/done": htmlPage(`<p>Your file is ready</p>`),
    };
    mockFetch.mockImplementation(async (url: string) => ({
      text: async () => pages[url] ?? "",
    }));

    const trace = await followHtmlHops("https://hop1.example/");
    expect(trace.url).toBe("https://final.example/done");
    expect(trace.methods).toEqual(["script_tag", "script_tag"]);
  });

  it("stops when a page only has generic outbound links (weak signal)", async () => {
    const pages: Record<string, string> = {
      "https://hop1.example/": htmlPage(`<script>var next = "https://hop2.example/step2";</script>`),
      // final-looking page: only a plain anchor to somewhere else
      "https://hop2.example/step2": htmlPage(
        `<p>Article</p><a href="https://other.example/read-more">read more</a>`
      ),
    };
    mockFetch.mockImplementation(async (url: string) => ({
      text: async () => pages[url] ?? "",
    }));

    const trace = await followHtmlHops("https://hop1.example/");
    expect(trace.url).toBe("https://hop2.example/step2");
    expect(trace.methods).toEqual(["script_tag"]);
  });

  it("stops on cycles instead of looping forever", async () => {
    const pages: Record<string, string> = {
      "https://a.example/": htmlPage(`<script>var next = "https://b.example/";</script>`),
      "https://b.example/": htmlPage(`<script>var back = "https://a.example/";</script>`),
    };
    mockFetch.mockImplementation(async (url: string) => ({
      text: async () => pages[url] ?? "",
    }));

    const trace = await followHtmlHops("https://a.example/");
    expect(trace.url).toBe("https://b.example/");
    expect(trace.methods).toEqual(["script_tag"]);
  });

  it("returns the start URL when nothing is found", async () => {
    mockFetch.mockImplementation(async () => ({ text: async () => htmlPage("<p>empty</p>") }));
    const trace = await followHtmlHops("https://plain.example/");
    expect(trace.url).toBe("https://plain.example/");
    expect(trace.methods).toEqual([]);
  });
});
