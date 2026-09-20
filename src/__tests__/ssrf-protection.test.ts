import { describe, it, expect } from "vitest";
import { resolveAndValidate } from "../security/ssrf-protection.js";

describe("resolveAndValidate", () => {
  it("blocks localhost", async () => {
    const result = await resolveAndValidate("localhost");
    expect(result.safe).toBe(false);
  });

  it("blocks 127.x IPs", async () => {
    const result = await resolveAndValidate("127.0.0.1");
    expect(result.safe).toBe(false);
  });

  it("blocks 10.x private IPs", async () => {
    const result = await resolveAndValidate("10.0.0.1");
    expect(result.safe).toBe(false);
  });

  it("blocks 192.168.x private IPs", async () => {
    const result = await resolveAndValidate("192.168.1.1");
    expect(result.safe).toBe(false);
  });

  it("blocks 172.16.x private IPs", async () => {
    const result = await resolveAndValidate("172.16.0.1");
    expect(result.safe).toBe(false);
  });

  it("blocks 0.0.0.0", async () => {
    const result = await resolveAndValidate("0.0.0.0");
    expect(result.safe).toBe(false);
  });

  it("resolves public hostname to safe", async () => {
    const result = await resolveAndValidate("example.com");
    expect(result.safe).toBe(true);
    expect(result.resolvedIp).toBeDefined();
  });
});
