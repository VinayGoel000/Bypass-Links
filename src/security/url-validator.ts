const BLOCKED_PROTOCOLS = [
  "file:",
  "ftp:",
  "javascript:",
  "data:",
  "vbscript:",
  "telnet:",
  "ssh:",
  "sftp:",
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
];

export interface ValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

export function validateUrl(input: string): ValidationResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, error: "Empty URL" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      valid: false,
      error: `Unsupported protocol: ${url.protocol}. Only HTTP and HTTPS are allowed.`,
    };
  }

  const protocolLower = url.protocol.toLowerCase();
  for (const blocked of BLOCKED_PROTOCOLS) {
    if (protocolLower === blocked) {
      return {
        valid: false,
        error: `Blocked protocol: ${blocked}`,
      };
    }
  }

  const hostname = url.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return {
        valid: false,
        error: `Blocked hostname: ${hostname}`,
      };
    }
  }

  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return {
      valid: false,
      error: `Blocked internal hostname: ${hostname}`,
    };
  }

  return { valid: true, url };
}

export function extractUrl(text: string): string | null {
  const trimmed = text.trim();

  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/i;
  const match = trimmed.match(urlRegex);
  if (match) {
    return match[0];
  }

  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }

  return null;
}
