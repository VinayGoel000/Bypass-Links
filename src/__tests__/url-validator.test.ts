import { describe, it, expect } from "vitest";
import { validateUrl, extractUrl } from "../security/url-validator.js";

describe("validateUrl", () => {
  it("accepts valid http URL", () => {
    const result = validateUrl("http://example.com");
    expect(result.valid).toBe(true);
  });

  it("accepts valid https URL", () => {
    const result = validateUrl("https://example.com/path?q=1");
    expect(result.valid).toBe(true);
  });

  it("rejects empty URL", () => {
    expect(validateUrl("").valid).toBe(false);
    expect(validateUrl("  ").valid).toBe(false);
  });

  it("rejects invalid URL format", () => {
    expect(validateUrl("not-a-url").valid).toBe(false);
    expect(validateUrl("://missing-scheme").valid).toBe(false);
  });

  it("rejects file:// protocol", () => {
    expect(validateUrl("file:///etc/passwd").valid).toBe(false);
  });

  it("rejects ftp:// protocol", () => {
    expect(validateUrl("ftp://example.com/file").valid).toBe(false);
  });

  it("rejects javascript: protocol", () => {
    expect(validateUrl("javascript:alert(1)").valid).toBe(false);
  });

  it("rejects data: protocol", () => {
    expect(validateUrl("data:text/html,<h1>hi</h1>").valid).toBe(false);
  });

  it("rejects localhost", () => {
    expect(validateUrl("http://localhost").valid).toBe(false);
    expect(validateUrl("http://localhost:3000").valid).toBe(false);
    expect(validateUrl("http://sub.localhost").valid).toBe(false);
  });

  it("rejects internal hostnames", () => {
    expect(validateUrl("http://example.internal").valid).toBe(false);
    expect(validateUrl("http://host.local").valid).toBe(false);
  });
});

describe("extractUrl", () => {
  it("extracts URL from text", () => {
    expect(extractUrl("check this https://example.com")).toBe("https://example.com");
  });

  it("returns bare domain with https prefix", () => {
    expect(extractUrl("example.com")).toBe("https://example.com");
  });

  it("returns null for plain text", () => {
    expect(extractUrl("hello world")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractUrl("")).toBeNull();
  });
});
