import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { RawLlmPlan } from "./index";

export interface CodexStatus {
  connected: boolean;
  codexHome: string;
  authFile: string;
}

function stateRoot(): string {
  return resolve(process.env.QUOTE_TRADE_STATE_DIR ?? ".quote-trade");
}

function ownerKey(ownerId?: string): string {
  const owner = String(ownerId || "default").trim() || "default";
  return createHash("sha256").update(owner).digest("hex").slice(0, 32);
}

function codexBin(): string {
  return String(process.env.CODEX_BIN || "codex");
}

function timeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function codexHomeForOwner(ownerId = "default"): string {
  const dir = join(stateRoot(), "users", ownerKey(ownerId), "codex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

export function codexAuthFile(ownerId = "default"): string {
  return join(codexHomeForOwner(ownerId), "auth.json");
}

function codexWorkspace(ownerId = "default"): string {
  const dir = join(stateRoot(), "users", ownerKey(ownerId), "codex-workspace");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

function ensureCodexConfig(ownerId = "default"): string {
  const home = codexHomeForOwner(ownerId);
  const file = join(home, "config.toml");
  if (!existsSync(file)) {
    writeFileSync(file, [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      'model_reasoning_effort = "low"',
      'sandbox_mode = "read-only"',
      '',
    ].join("\n"), { mode: 0o600 });
  }
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

function codexEnv(ownerId = "default"): Record<string, string> {
  const home = codexHomeForOwner(ownerId);
  const env: Record<string, string> = {
    PATH: String(process.env.PATH || ""),
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    TERM: String(process.env.TERM || "dumb"),
    NO_COLOR: "1",
  };
  const ca = process.env.CODEX_CA_CERTIFICATE || process.env.SSL_CERT_FILE;
  if (ca) env.CODEX_CA_CERTIFICATE = String(ca);
  return env;
}

export function hasCodexOAuthSession(ownerId = "default"): boolean {
  const file = codexAuthFile(ownerId);
  if (!existsSync(file)) return false;
  try {
    const text = readFileSync(file, "utf8");
    return /chatgpt|access|refresh/i.test(text);
  } catch {
    return false;
  }
}

export function codexOAuthStatus(ownerId = "default"): CodexStatus {
  const authFile = codexAuthFile(ownerId);
  return { connected: hasCodexOAuthSession(ownerId), codexHome: codexHomeForOwner(ownerId), authFile };
}

export async function runCodexOAuthLogin(ownerId = "default"): Promise<void> {
  ensureCodexConfig(ownerId);
  const { spawn } = require("node:child_process");
  const proc = spawn(codexBin(), ["login", "--device-auth"], {
    stdio: "inherit",
    env: codexEnv(ownerId),
  });
  const code = await new Promise<number>((resolve, reject) => {
    proc.on("exit", (exitCode: number) => resolve(exitCode ?? 0));
    proc.on("error", reject);
  });
  if (code !== 0) throw new Error(`Codex OAuth login failed with exit code ${code}`);
  try { chmodSync(codexAuthFile(ownerId), 0o600); } catch { /* best effort */ }
  if (!hasCodexOAuthSession(ownerId)) throw new Error("Codex login finished, but no ChatGPT OAuth session was found in CODEX_HOME/auth.json");
}

export function logoutCodexOAuth(ownerId = "default"): boolean {
  const file = codexAuthFile(ownerId);
  if (!existsSync(file)) return false;
  try { unlinkSync(file); } catch { return false; }
  return true;
}

const CODEX_PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "commands", "riskNotes"],
  properties: {
    summary: { type: "string" },
    commands: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
    riskNotes: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
  },
};

function parseCodexJson(raw: string): RawLlmPlan {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Codex returned an empty plan");
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(clean); } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("Codex did not return a JSON object");
  }
}

export async function completeCodexOAuthPlan(ownerId: string, model: string, request: { systemPrompt: string; userPrompt: string }): Promise<RawLlmPlan> {
  const owner = String(ownerId || "default").trim() || "default";
  if (!hasCodexOAuthSession(owner)) throw new Error(`Codex OAuth is not connected for owner ${owner}. Run codex:connect first.`);
  ensureCodexConfig(owner);

  const home = codexHomeForOwner(owner);
  const workspace = codexWorkspace(owner);
  const schemaPath = join(home, "quote-trade-plan.schema.json");
  const outputPath = join(home, `quote-trade-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(schemaPath, JSON.stringify(CODEX_PLAN_RESPONSE_SCHEMA), { mode: 0o600 });

  const prompt = [
    request.systemPrompt,
    "",
    request.userPrompt,
    "",
    "Return JSON only. Do not run shell commands. Do not access files. Do not submit trades.",
  ].join("\n");

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--cd", workspace,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
  ];
  if (model && model !== "default") args.push("--model", model);
  args.push("-");

  const { spawn } = require("node:child_process");
  const proc = spawn(codexBin(), args, { stdio: ["pipe", "pipe", "pipe"], env: codexEnv(owner) });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: any) => { stdout += String(chunk); });
  proc.stderr.on("data", (chunk: any) => { stderr += String(chunk); });
  proc.stdin.write(prompt);
  proc.stdin.end();

  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("Codex strategy planning timed out"));
    }, timeoutMs("CODEX_EXEC_TIMEOUT_MS", 120_000));
    timer.unref?.();
    proc.on("exit", (exitCode: number) => { clearTimeout(timer); resolve(exitCode ?? 0); });
    proc.on("error", (error: any) => { clearTimeout(timer); reject(error); });
  });

  if (code !== 0) throw new Error(`Codex strategy planning failed${stderr ? `: ${stderr.slice(-500)}` : ""}`);
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : stdout;
  try { unlinkSync(outputPath); } catch { /* ignore */ }
  return parseCodexJson(output);
}
