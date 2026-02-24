import axios from 'axios';
import { getSigningContext } from "../auth/signing-context";
import { signRequest } from "../auth/signing";

/**
 * HTTP service for authenticated API requests.
 *
 * Signing is delegated to the active SigningContext (set by resolveCredentials()).
 * The context determines whether HMAC-SHA256 or Ed25519 is used for the
 * `signature` header, and which API key is sent as `X-Mbx-Apikey`.
 *
 * Signing method summary:
 *  sha256  → signature = HMAC-SHA256(TRADE_API_SECRET, payload) → hex
 *            X-Mbx-Apikey = TRADE_API_KEY
 *  ed25519 → signature = Ed25519.sign(TRADE_API_SECRET as PKCS#8 PEM, payload) → base64
 *            X-Mbx-Apikey = TRADE_API_KEY
 *
 * Payload:
 *  POST → JSON.stringify(reqBody)  (after channel field is added to body)
 *  GET  → JSON.stringify(path)     (the path string, matching legacy behavior)
 *
 * Note: channel is added to the request BODY only (not as a URL query parameter).
 * This ensures the signed payload matches exactly what the server receives in the body.
 */
class HttpService {
  private readonly apiUrl: string;
  private readonly channel = 'LIQUIDITY';

  constructor() {
    this.apiUrl = `${process.env.API_BASE_URL}`;
  }

  private getFullPath(path: string) {
    return `${this.apiUrl}${path}`;
  }

  public async get(path: string, config: any = {}): Promise<string> {
    const fullUrl = this.getFullPath(path);
    const configHeaders: any = {
      headers: config.headers || {},
    };

    // Resolve signing context at request time (lazy — allows resolveCredentials() to run first)
    try {
      const ctx = getSigningContext();
      if (ctx.signingSecret) {
        configHeaders.headers.signature = signRequest(ctx, JSON.stringify(path));
      }
      if (ctx.apiKey) {
        configHeaders.headers['X-Mbx-Apikey'] = ctx.apiKey;
      }
    } catch {
      // No signing context available — proceed unsigned (e.g. public endpoints)
    }

    return new Promise((resolve, reject) => {
      axios
        .get(fullUrl, configHeaders)
        .then((response) => {
          const data = response.data;
          if (data != null && typeof data === 'object') {
            if (data.status === 'error' || data.error) {
              reject(data);
              return;
            }
          }
          resolve(data != null ? data : {});
        })
        .catch((error) => {
          reject(error);
        });
    });
  }

  public async post(path: string, reqBody: any, config: any = {}): Promise<string> {
    const fullUrl = this.getFullPath(path);
    const configHeaders: any = {
      headers: config.headers || {},
    };

    reqBody.channel = this.channel;

    // Resolve signing context at request time (lazy — allows resolveCredentials() to run first)
    try {
      const ctx = getSigningContext();
      if (ctx.signingSecret) {
        configHeaders.headers.signature = signRequest(ctx, JSON.stringify(reqBody));
      }
      if (ctx.apiKey) {
        axios.defaults.headers.common['X-Mbx-Apikey'] = ctx.apiKey;
      }
    } catch {
      // No signing context available — proceed unsigned (e.g. public endpoints)
    }

    return new Promise((resolve, reject) => {
      axios
        .post(fullUrl, reqBody, configHeaders)
        .then((response) => {
          delete axios.defaults.headers.common['X-Mbx-Apikey'];

          const data = response.data;
          if (data != null && typeof data === 'object') {
            if (data.status === 'error' || data.error) {
              reject(data);
              return;
            }
          }
          resolve(data != null ? data : {});
        })
        .catch((error) => {
          delete axios.defaults.headers.common['X-Mbx-Apikey'];
          reject(error);
        });
    });
  }

}

export const HttpSvc = new HttpService();
