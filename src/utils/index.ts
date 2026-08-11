import { HttpSvc } from "../services/http.service";
export function tfToMs(tf: string): number {
  const map: any = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
  const value = map[String(tf).toLowerCase()];
  if (!value) throw new Error(`Unsupported timeframe ${tf}`);
  return value;
}
export async function getInstrumentMeta(symbol: string): Promise<any> {
  try {
    const data = await HttpSvc.get("/getInstrumentPairs?skip=0&limit=1000");
    const pairs = data?.instrumentPairs ?? data?.data ?? [];
    return (
      pairs.find((p: any) => String(p.symbol ?? p.s ?? "").toUpperCase() === symbol.toUpperCase()) ?? {
        symbol,
        quantityScale: 6,
      }
    );
  } catch {
    return { symbol, quantityScale: 6 };
  }
}
