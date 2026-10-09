// Local LLM for `--llm llama` runs: llama-server (OpenAI-compatible) with
// Qwen3-1.7B Q4_0 on port 8110. Started if not already running, and stopped
// at the end if this process started it. The model only drafts follow-up
// wording; workflow behavior never depends on it (ADR 0004).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LLAMA_PORT = 8110;
export const LLAMA_MODEL_PATH = join(homedir(), "Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf");
export const LLAMA_BASE_URL = `http://127.0.0.1:${LLAMA_PORT}/v1`;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${LLAMA_PORT}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureLlama(logDir: string): Promise<{ stop: () => Promise<void>; startedHere: boolean }> {
  if (await healthy()) return { stop: async () => undefined, startedHere: false };
  if (!existsSync(LLAMA_MODEL_PATH)) throw new Error(`model not found: ${LLAMA_MODEL_PATH}`);
  const log = openSync(join(logDir, "llama-server.log"), "a");
  const child: ChildProcess = spawn(
    "llama-server",
    ["-m", LLAMA_MODEL_PATH, "--host", "127.0.0.1", "--port", String(LLAMA_PORT), "-np", "1", "-c", "8192", "-ngl", "99", "--jinja"],
    { detached: true, stdio: ["ignore", log, log] },
  );
  const stop = async () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // gone
    }
    for (let i = 0; i < 20 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  };
  const end = Date.now() + 180_000;
  while (!(await healthy())) {
    if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}; see ${join(logDir, "llama-server.log")}`);
    if (Date.now() > end) {
      await stop();
      throw new Error("llama-server did not become healthy within 180 s");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { stop, startedHere: true };
}
