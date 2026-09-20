export type SecurityStatus = "SAFE_TO_VISIT" | "SUSPICIOUS" | "UNKNOWN";

export interface ReputationCheckResult {
  status: SecurityStatus;
  details?: string;
}

export async function checkReputation(_url: string): Promise<ReputationCheckResult> {
  return {
    status: "UNKNOWN",
    details: "No reputation service configured. Add VirusTotal or Google Safe Browsing API key.",
  };
}
