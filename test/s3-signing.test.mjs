import test from "node:test";
import assert from "node:assert/strict";
import { createS3, putIfChanged, writeTimeoutMsFor,
         WRITE_TIMEOUT_FLOOR_MS, WRITE_TIMEOUT_CEIL_MS } from "../lib/s3.js";

// Optional live check: set RUSTFS_SMOKE=1 with real .env creds to verify
// SigV4 signing against the actual RustFS (read-only listBuckets).
test("s3 client rejects missing credentials", () => {
  assert.throws(() => createS3({ endpoint: undefined, accessKey: "a", secretKey: "b" }));
});

test("putIfChanged skips when content-length matches", async (t) => {
  let putCalls = 0;
  const fakeS3 = {
    headObject: async (bucket, key) => ({ contentLength: 11 }),
    putObject: async () => {
      putCalls++;
      return {};
    },
  };
  const res = await putIfChanged(fakeS3, "b", "k", "hello world");
  assert.equal(res.skipped, true);
  assert.equal(putCalls, 0);
  const res2 = await putIfChanged(fakeS3, "b", "k", "different!");
  assert.equal(res2.skipped, false);
  assert.equal(putCalls, 1);
});

// getObject's timeout must cover the body read, not just the response
// headers: a half-open RustFS GET used to hang the loader forever.
test("getObject aborts a stalled download and succeeds on retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    if (calls > 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("payload").buffer,
      });
    }
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    const buf = await s3.getObject("b", "k", { timeoutMs: 25, retries: 1 });
    assert.equal(buf.toString("utf8"), "payload");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObject surfaces a timeout once retries are exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    await assert.rejects(s3.getObject("b", "k", { timeoutMs: 20, retries: 1 }), /timed out after 20ms/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObject does not retry a 4xx response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 403, text: async () => "denied" };
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    await assert.rejects(s3.getObject("b", "k", { timeoutMs: 500, retries: 2 }), /getObject b\/k: 403/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live SigV4 smoke (RUSTFS_SMOKE=1)", async (t) => {
  if (!process.env.RUSTFS_SMOKE) return t.skip("set RUSTFS_SMOKE=1 with real .env to run");
  const { loadConfig } = await import("../lib/config.js");
  const cfg = loadConfig();
  const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
  const buckets = await s3.listBuckets();
  assert.ok(Array.isArray(buckets));
  console.log("buckets:", buckets.join(", "));
});

// ── 写预算按对象大小算 ────────────────────────────────────────────────────
//
// 2026-11-14 实测（真实代码路径，生产集群 → 内网 RustFS）：4MB/30.9s = 132KB/s 通过，
// 8MB 在 60s 上限被 abort ⇒ 60s 默认值等于「≈8MB 以上永远写不进去」，
// 而扫描版 PDF 就这个尺寸。写不进去不是慢，是文档永不收敛（附件上传抛错
// → rememberFailure → state 哈希不落盘 → 每天重下重试 → failure threshold
// 把整轮 abort，03:20 那轮 mfa-treaty-crawl 就是这样 emitted=0）。
test("writeTimeoutMsFor: 小对象守 60s 下限，大对象按字节放大，封顶 900s", () => {
  const MB = 1024 * 1024;
  assert.equal(writeTimeoutMsFor(0), WRITE_TIMEOUT_FLOOR_MS);
  assert.equal(writeTimeoutMsFor(64 * 1024), WRITE_TIMEOUT_FLOOR_MS);
  assert.equal(writeTimeoutMsFor(1 * MB), 96_000);
  assert.equal(writeTimeoutMsFor(4 * MB), 384_000);
  // 实测会超时的那个尺寸：8MB 必须拿到远大于 60s 的预算，而不是被 abort
  assert.equal(writeTimeoutMsFor(8 * MB), 768_000);
  assert.ok(writeTimeoutMsFor(8 * MB) > 60_000);
  assert.equal(writeTimeoutMsFor(64 * MB), WRITE_TIMEOUT_CEIL_MS);
  assert.equal(writeTimeoutMsFor(Number.NaN), WRITE_TIMEOUT_FLOOR_MS, "坏输入退回下限，不许变成 NaN 预算");
});

test("putObject 把显式 timeoutMs 传到请求上（默认预算不是死值）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    await assert.rejects(
      () => s3.putObject("b", "k", Buffer.alloc(1024), { timeoutMs: 25 }),
      /timed out after 25ms/,
      "putObject 必须接受并转发 timeoutMs —— 否则大对象只能吃 60s 默认值",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
