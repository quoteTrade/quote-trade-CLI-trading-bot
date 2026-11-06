import axios from "axios";
import { signRequest } from "../auth/signing";
import { getSigningContext } from "../auth/signing-context";

class HttpService {
  private readonly apiUrl = `${process.env.API_BASE_URL ?? ""}`.replace(/\/$/, "");
  private full(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${this.apiUrl}${path}`;
  }
  private query(path: string): string {
    const start = path.indexOf("?");
    if (start === -1) return "";
    return path.slice(start + 1).split("#", 1)[0];
  }
  private headersFor(payload: string, config: any = {}): any {
    const headers = { ...(config.headers || {}) };
    const ctx = getSigningContext();
    if (ctx.apiKey) headers["X-Mbx-Apikey"] = ctx.apiKey;
    if (ctx.signingSecret) headers.signature = signRequest(ctx, payload);
    return headers;
  }
  async get(path: string, config: any = {}): Promise<any> {
    const resp = await axios.get(this.full(path), { ...config, headers: this.headersFor(this.query(path), config) });
    return resp.data;
  }
  async post(path: string, body: any = {}, config: any = {}): Promise<any> {
    const payload = JSON.stringify({ ...body, channel: body.channel ?? "LIQUIDITY" });
    const headers = this.headersFor(payload, config);
    if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
    const resp = await axios.post(this.full(path), payload, {
      ...config,
      headers,
      transformRequest: [(data: string) => data],
    });
    return resp.data;
  }
}
export const HttpSvc = new HttpService();
