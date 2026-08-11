import type { PositionStore } from "./position-store";

export interface HttpLike {
  get(path: string, config?: any): Promise<any>;
}

function extractPositions(payload: any): { found: boolean; positions: any[] } {
  // Support ACCOUNT_UPDATE-style WS payload if API returns same shape.
  if (Array.isArray(payload?.a?.P)) {
    return { found: true, positions: payload.a.P };
  }

  return { found: false, positions: [] };
}

export class PositionSyncService {
  constructor(
    private http: HttpLike,
    private store: PositionStore,
  ) {}

  async refresh(config: any = {}): Promise<number> {
    const path = process.env.POSITIONS_ENDPOINT || "/positions";

    let lastError: unknown;

    try {
      const payload = await this.http.get(path, config);
      const extracted: any = extractPositions(payload);

      if (!extracted.found) {
        return 0;
      }

      // REST /positions is authoritative, so replace stale cached positions.
      this.store.replace(extracted.positions);
      return extracted.positions.length;
    } catch (e) {
      lastError = e;
    }

    if (lastError) throw lastError;
    return 0;
  }
}
