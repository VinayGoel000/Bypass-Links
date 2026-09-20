import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.BOT_TOKEN = "test-token";

vi.mock("../security/ssrf-protection.js", () => ({
  resolveAndValidate: vi.fn().mockResolvedValue({ safe: true, resolvedIp: "93.184.216.34" }),
}));

import { resolveUrl } from "../resolver/url-resolver.js";
import * as ssrf from "../security/ssrf-protection.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(status: number, headers?: Record<string, string>) {
  return {
    status,
    headers: {
      get: (name: string) => headers?.[name.toLowerCase()] ?? null,
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(ssrf.resolveAndValidate).mockResolvedValue({ safe: true, resolvedIp: "93.184.216.34" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveUrl", () => {
  it("resolves a direct URL (no redirects)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));

    const result = await resolveUrl("https://example.com");
    expect(result.success).toBe(true);
    expect(result.finalUrl).toBe("https://example.com");
    expect(result.chain.count).toBe(0);
  });

  it("follows a single 302 redirect", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(302, { location: "https://example.com/final" }))
      .mockResolvedValueOnce(mockResponse(200));

    const result = await resolveUrl("https://short.example.com/abc");
    expect(result.success).toBe(true);
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.chain.count).toBe(1);
  });

  it("follows multiple redirects", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(301, { location: "https://step1.example.com" }))
      .mockResolvedValueOnce(mockResponse(302, { location: "https://step2.example.com" }))
      .mockResolvedValueOnce(mockResponse(200));

    const result = await resolveUrl("https://start.example.com");
    expect(result.success).toBe(true);
    expect(result.finalUrl).toBe("https://step2.example.com/");
    expect(result.chain.count).toBe(2);
  });

  it("handles relative redirect", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(302, { location: "/new-path" }))
      .mockResolvedValueOnce(mockResponse(200));

    const result = await resolveUrl("https://example.com/old");
    expect(result.success).toBe(true);
    expect(result.finalUrl).toBe("https://example.com/new-path");
  });

  it("detects redirect loops", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(302, { location: "https://b.com" }))
      .mockResolvedValueOnce(mockResponse(302, { location: "https://a.com" }));

    const result = await resolveUrl("https://a.com");
    expect(result.success).toBe(false);
    expect(result.error).toContain("loop");
  });

  it("handles missing Location header", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(302));

    const result = await resolveUrl("https://example.com");
    expect(result.success).toBe(false);
    expect(result.error).toContain("no Location header");
  });

  it("handles timeout", async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error("Aborted"), { name: "AbortError" }));

    const result = await resolveUrl("https://slow.example.com");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout");
  });

  it("handles connection failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await resolveUrl("https://unreachable.example.com");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection failed");
  });

  it("blocks SSRF targets", async () => {
    vi.mocked(ssrf.resolveAndValidate).mockResolvedValueOnce({
      safe: false,
      error: "Blocked: localhost resolves to private IP 127.0.0.1",
    });

    const result = await resolveUrl("http://localhost:3000/admin");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked");
  });
});
