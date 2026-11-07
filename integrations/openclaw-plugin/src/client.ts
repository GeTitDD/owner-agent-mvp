import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OwnerSidecarOptions {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  operatorId?: string;
  pluginVersion?: string;
}

export interface OwnerSidecarConfig {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  operatorId?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:47830";
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/u;

const readTokenFile = (file: string): string => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * 极薄的 Owner sidecar 客户端：只做 HTTP + 头处理，不含任何业务规则。
 * 所有审批哈希与状态判断都由 Owner 侧决定。
 */
export class OwnerSidecarClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly origin: Record<string, string>;

  constructor(options: OwnerSidecarOptions = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    if (!LOOPBACK.test(baseUrl)) {
      throw new Error("owner-agent: baseUrl must be a loopback http URL");
    }
    this.baseUrl = baseUrl;
    this.token = (options.token ?? "").trim()
      || readTokenFile(options.tokenFile ?? "")
      || readTokenFile(join(homedir(), ".domain-context", "sidecar.token"));
    if (!this.token) {
      throw new Error(
        "owner-agent: sidecar token is missing; set plugins.entries.owner-agent.config.tokenFile"
      );
    }
    this.origin = {
      operatorId: options.operatorId ?? "owner",
      pluginVersion: options.pluginVersion ?? "0.1.0"
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "x-owner-origin": JSON.stringify(this.origin)
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new Error(
        `owner-agent: ${method} ${path} failed (${response.status}) ${payload?.error ?? ""}`.trim()
      );
    }
    return payload;
  }

  get(path: string): Promise<any> {
    return this.request("GET", path);
  }

  post(path: string, body?: unknown): Promise<any> {
    return this.request("POST", path, body);
  }
}

export const encodeId = (value: string): string => encodeURIComponent(value);
