import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithRetry } from "../lib/http.js";

/** 起一个受控上游：每个用例自己决定怎么发、什么时候断。 */
function serve(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

test("正常响应：headers 后 body 一次到达，内容可读", async () => {
  const up = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, n: 3 }));
  });
  try {
    const res = await fetchWithRetry(up.url, {}, { retries: 0, timeoutMs: 2000, rateLimit: false });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, n: 3 });
  } finally {
    await up.close();
  }
});

test("半开响应体：headers 到了、body 不再发 ⇒ 按 bodyIdle 超时而不是永久挂住", async () => {
  const up = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial-");              // 发一点，然后永不 end
  });
  try {
    const t0 = Date.now();
    const res = await fetchWithRetry(up.url, {}, {
      retries: 0, timeoutMs: 5000, bodyIdleTimeoutMs: 250, rateLimit: false,
    });
    assert.equal(res.status, 200);      // 头确实到了——这正是旧的挂死点
    await assert.rejects(
      () => res.text(),
      (err) => {
        const spent = Date.now() - t0;
        assert.ok(spent < 3000, `应在 idle 超时后立刻失败，实际 ${spent}ms`);
        assert.match(String(err?.name || err?.message), /Abort|abort|terminat/i);
        return true;
      },
    );
  } finally {
    await up.close();
  }
});

test("慢但持续到达：每个 chunk 重置 deadline ⇒ 不应被判超时", async () => {
  const up = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let i = 0;
    const tick = setInterval(() => {
      i += 1;
      res.write(`chunk${i};`);
      if (i === 3) { clearInterval(tick); res.end(); }
    }, 80);
  });
  try {
    const res = await fetchWithRetry(up.url, {}, {
      retries: 0, timeoutMs: 5000, bodyIdleTimeoutMs: 300, rateLimit: false,
    });
    const text = await res.text();
    assert.equal(text, "chunk1;chunk2;chunk3;");
  } finally {
    await up.close();
  }
});

test("流式读取仍可用（getReader 路径不被缓冲掉）", async () => {
  const up = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(1024, 1));
    res.write(Buffer.alloc(1024, 2));
    res.end();
  });
  try {
    const res = await fetchWithRetry(up.url, {}, { retries: 0, timeoutMs: 5000, rateLimit: false });
    assert.equal(typeof res.body?.getReader, "function");
    const reader = res.body.getReader();
    let total = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks += 1;
    }
    assert.equal(total, 2048);
    // 不assert chunk 数：上游两次 write 可能被合并成一个 TCP 段、TransformStream
    // 也可能逐段透传——那不是契约。这里只证「流式读取仍然可用且内容完整」。
    assert.ok(chunks >= 1);
  } finally {
    await up.close();
  }
});

test("无正文状态（204）不会因 Response 构造函数抛错", async () => {
  const up = await serve((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const res = await fetchWithRetry(up.url, {}, { retries: 0, timeoutMs: 5000, rateLimit: false });
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  } finally {
    await up.close();
  }
});
