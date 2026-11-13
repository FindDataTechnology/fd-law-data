// Rate-limited fetch with retry/backoff. One global limiter keeps flk pacing
// honest across list/detail/download calls (~1 req/s by default).
const MIN_INTERVAL_MS_DEFAULT = 1100;
let lastAt = 0;
let chain = Promise.resolve();

export function setMinInterval(ms) {
  minInterval = ms;
}
let minInterval = MIN_INTERVAL_MS_DEFAULT;

function gate() {
  const run = chain.then(async () => {
    const now = Date.now();
    const wait = lastAt + minInterval - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给响应体加**空闲超时**，但保持流式（不缓冲、不改 `boundedBuffer` 的 413 语义）。
 *
 * 为什么必须这么做：`fetch()` 在**响应头**到达时就 resolve，此后读 body 完全不受
 * `timeoutMs` 约束。服务端发完头就不再发包（半开响应体）时，读会永远挂着——
 * 2026-11-13 实测 `scraw/gov-rules-crawl` 与 `mfa-treaty-crawl` 就这样在
 * `node` 里睡死 25 分钟以上、**零日志零重试**，直到 `activeDeadlineSeconds`
 * 才被杀（8h）；而同一 URL 新建连接 135ms 就通。判据是 `/proc/1`：进程 State=S、
 * 8 秒只走 1 个 tick、只剩一条 ESTABLISHED。
 *
 * `lib/s3.js` 早就修过同一个坑（body 读在 clearTimeout 之前，注释原话
 * "a plain fetch() resolves on headers and would leave the read hanging forever"），
 * 这里把同一条纪律补到 http 层：每个 chunk 重置一次 deadline，闲置即 abort。
 */
function guardBodyDeadline(res, url, idleMs, ctrl) {
  if (!res.body || typeof res.body.pipeThrough !== "function") return res;
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleMs);
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  arm();
  const guard = new TransformStream({
    transform(chunk, controller) {
      arm();
      controller.enqueue(chunk);
    },
    flush() {
      disarm();
    },
    cancel() {
      disarm();
    },
  });
  const body = res.body.pipeThrough(guard);
  // 204/205/304 是「无正文」状态：Response 构造函数带 body 会直接抛
  // TypeError（"Response with null body status cannot have body"）。今天没有调用方
  // 发条件请求或读这些状态，但代理/网关回一个 204 就会把整条链路炸掉——三行堵死。
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(nullBody ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export async function fetchWithRetry(
  url,
  opts = {},
  { retries = 4, timeoutMs = 30000, rateLimit = true, bodyIdleTimeoutMs = null } = {},
) {
  let lastErr;
  const idleMs = bodyIdleTimeoutMs ?? timeoutMs;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (rateLimit) await gate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < retries) {
          const ra = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 1000);
          continue;
        }
        throw lastErr;
      }
      return guardBodyDeadline(res, url, idleMs, ctrl);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`fetch failed: ${url}`);
}

export async function fetchJson(url, opts = {}, retryOpts = {}) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
