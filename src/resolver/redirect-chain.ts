export interface RedirectHop {
  url: string;
  statusCode: number;
  timestamp: number;
}

export class RedirectChain {
  private hops: RedirectHop[] = [];

  add(url: string, statusCode: number): void {
    this.hops.push({
      url,
      statusCode,
      timestamp: Date.now(),
    });
  }

  get first(): string | undefined {
    return this.hops[0]?.url;
  }

  get last(): string | undefined {
    return this.hops[this.hops.length - 1]?.url;
  }

  get count(): number {
    return Math.max(0, this.hops.length - 1);
  }

  getHops(): readonly RedirectHop[] {
    return [...this.hops];
  }

  hasLoop(): boolean {
    const seen = new Set<string>();
    for (const hop of this.hops) {
      let normalized: string;
      try {
        normalized = new URL(hop.url).href;
      } catch {
        normalized = hop.url;
      }
      if (seen.has(normalized)) return true;
      seen.add(normalized);
    }
    return false;
  }

  format(): string {
    return this.hops
      .map((hop, i) => `${i + 1}. ${hop.url}`)
      .join("\n");
  }
}
