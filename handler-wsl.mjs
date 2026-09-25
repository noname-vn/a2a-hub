/**
 * hermes-wsl A2A handler — dạng module mà agent-ws-client.js cần.
 *
 * Root cause (do hermes-mac phát hiện 24/09): client import bằng
 * `const { default: handler } = await import(PATH)` — file cũ
 * (agent-hermes-wsl.js) là HTTP server ESM KHÔNG có default export →
 * handler = undefined → "TypeError: handler is not a function" mỗi lần
 * hermes-mac gọi sang. File này export đúng chuẩn:
 *   export default async (text) => string
 *
 * Tái dùng logic runHermes từ HTTP server cũ (hermes -z + timeout + maxBuffer).
 */
import { execFile } from 'node:child_process';

const HERMES_BIN = process.env.HERMES_BIN || '/opt/hermes/bin/hermes';
const TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT || 180_000);

/** Chạy hermes CLI với prompt — trả stdout (giới hạn 4000 ký tự). */
function runHermes(prompt) {
  return new Promise((resolve) => {
    execFile(
      HERMES_BIN,
      ['-z', prompt],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve(`[hermes lỗi] ${stderr || err.message}`.slice(0, 800));
        } else {
          resolve((stdout || stderr || '').trim().slice(0, 4000));
        }
      },
    );
  });
}

export default async function handler(text) {
  return runHermes(text || '');
}

// Client (agent-ws-client.js) cũng ăn CommonJS interop nếu import kiểu khác:
export { handler };