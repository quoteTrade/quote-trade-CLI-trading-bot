import axios from 'axios';
import crypto from "crypto";
import { signRequestBody } from "../auth/signing";

class HttpService {
  private readonly apiUrl: string;
  private readonly requestToken: string;
  private readonly requestSecret: string;
  private readonly channel = 'LIQUIDITY';

  constructor() {
    this.apiUrl = `${process.env.API_BASE_URL}`;
    this.requestToken = `${process.env.TRADE_API_KEY}`;
    this.requestSecret = `${process.env.TRADE_API_SECRET}`;
    // axios.defaults.headers.common['X-Mbx-Apikey'] = `${process.env.TRADE_API_KEY}`;
  }

  private getFullPath(path: string) {
    return path.includes("?") ? `${this.apiUrl}${path}&channel=${this.channel}` : `${this.apiUrl}${path}?channel=${this.channel}`;
  }

  private getCredentials(config: any) {
    return {
      requestToken: config.requestToken ?? process.env.TRADE_API_KEY ?? this.requestToken,
      requestSecret: config.requestSecret ?? process.env.TRADE_API_SECRET ?? this.requestSecret,
    };
  }

  public async get(path: string, config: any = {}): Promise<string> {
    const fullUrl = this.getFullPath(path);
    const configHeaders = {
      headers: config.headers || {},
    };
    const { requestSecret } = this.getCredentials(config);
    if (requestSecret) {
      configHeaders.headers.signature = crypto.createHmac("sha256", requestSecret)
          .update(JSON.stringify(path))
          .digest("hex");
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
            // Resolve with data or {} when body is empty (e.g. 204 or empty JSON)
            resolve(data != null ? data : {});
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

  public async post(path: string, reqBody: any, config: any = {}): Promise<string> {
    // Simulating an API request
    const fullUrl = this.getFullPath(path);
    const configHeaders = {
      headers: config.headers || {},
    };

    reqBody.channel = this.channel;

    const { requestToken, requestSecret } = this.getCredentials(config);
    if (requestSecret) {
      configHeaders.headers.signature = signRequestBody(requestSecret, reqBody);
    }
    if (requestToken) {
      axios.defaults.headers.common['X-Mbx-Apikey'] = requestToken;
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
