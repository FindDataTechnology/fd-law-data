// Object-storage contract for wave-1 legal sources:
//   legal-sources/<source>/{raw,structured,attachments,manifest}/...
// Keys are deterministic so snapshots can be reprocessed and audited in order.
export const LEGAL_SOURCES_ROOT = "legal-sources";

export function sourcePrefix(source) {
  if (!source || !/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error(`invalid legal source id: ${source}`);
  return `${LEGAL_SOURCES_ROOT}/${source}`;
}

export function stateKey(source) {
  return `${sourcePrefix(source)}/state.json`;
}

// state.json 的读取预算，与其它对象的默认值（lib/s3.js 的 60000ms）分开。
//
// 为什么单独给：state.json 是这一族里**唯一随语料单调增长**的对象——
// gov-rules-library 实测 1.43MB、mfa-treaty-library 657KB，而 party-regulation
// 只有 26KB。s3.js 的 timeoutMs 是**总预算且包含 body 读**（注释原话
// "Body read happens before the timeout is cleared"），而这条链路（rustfs 跑在
// Windows 宿主的 Docker Desktop 里，走 Tailscale）实测吞吐 0.02–9.6MB/s 抖动。
// 0.02MB/s 下 1.4MB 要 70 秒 > 60 秒 ⇒ 每次尝试 183s（3×60s 内部重试）后失败，
// Job 六次重试全落在同一个坏窗口内，以 BackoffLimitExceeded 收场。
//
// 2026-11-12 T19:20–T19:50 实测就是这个形态：同一窗口里 26KB 的 state.json
// 读得动、1.4MB 的读不动，而 rustfs 健康检查一路 200 —— 是吞吐不是可用性。
//
// 300s 覆盖到 0.005MB/s（比实测最差再差 4 倍）。**健康时零代价**：超时是上限，
// 不是延迟。判据仍然是「读不完才失败」，只是把「读不完」定义在可实测的吞吐之下。
export const STATE_READ_TIMEOUT_MS = 300_000;

// Sibling keys for a state REBUILD (scripts/rebuild-legal-source-state.mjs).
// The storage client has no rename/move, so the rebuild stages its new object
// at a temp key and only overwrites state.json once the staged bytes have been
// read back byte-identical; the previous object is copied to a backup first.
// Neither key sits under structured/ or manifest/, so coverage and report
// listings — which scan those two prefixes — never pick them up.
export function stateBackupKey(source, stamp) {
  return `${sourcePrefix(source)}/state.json.bak-${safeStamp(stamp)}`;
}

export function stateTempKey(source, stamp) {
  return `${sourcePrefix(source)}/state.json.rebuild-${safeStamp(stamp)}.tmp`;
}

// Keys are opaque strings here, so a stamp must never smuggle in a slash.
function safeStamp(stamp) {
  const text = String(stamp ?? "").replace(/[^0-9A-Za-z-]/g, "");
  return text || "unknown";
}

export function structuredPrefix(source) {
  return `${sourcePrefix(source)}/structured/`;
}

export function rawPrefix(source) {
  return `${sourcePrefix(source)}/raw/`;
}

export function attachmentsPrefix(source) {
  return `${sourcePrefix(source)}/attachments/`;
}

export function manifestPrefix(source) {
  return `${sourcePrefix(source)}/manifest/`;
}

// A part is immutable once complete. The run id (UTC timestamp, YYYYMMDDHHMMSS)
// is part of the key: a day-only key let a second run on the same day overwrite
// the first run's parts, and the fold then served only the later run's records
// while state.json still claimed the earlier ones were done — a permanently
// skipped set that even --full could not repair (ccdi full5 clobbered full3).
//
// Sort position is load-bearing, because the loader folds parts in key order
// with latest-wins per source_id: every id-bearing key sorts after every legacy
// day-only key, and id-bearing keys sort by run time, so a newer run always
// folds last. Both byte order and the loader's ICU collation order are covered
// by test/legal-sources-storage.test.mjs.
export function structuredPartKey(source, runId, part) {
  const stamp = String(runId ?? "");
  if (!/^[0-9]{14}$/.test(stamp)) throw new Error(`invalid legal source run id: ${runId}`);
  return `${structuredPrefix(source)}run-${stamp}-part${String(part).padStart(3, "0")}.jsonl`;
}

export function manifestKey(source, runDate, runId) {
  return `${manifestPrefix(source)}run-${runDate}-${runId}.manifest.json`;
}

// Keep object keys stable without letting a source id or URL introduce slashes.
export function safeSegment(value, { maxLength = 180 } = {}) {
  const text = String(value ?? "unnamed");
  let encoded = encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  if (encoded.length > maxLength) encoded = encoded.slice(0, maxLength);
  return encoded || "unnamed";
}

export function rawKey(source, sourceId, filename) {
  return `${rawPrefix(source)}${safeSegment(sourceId)}/${safeSegment(filename)}`;
}

export function attachmentKey(source, sourceId, filename) {
  return `${attachmentsPrefix(source)}${safeSegment(sourceId)}/${safeSegment(filename)}`;
}

export function runDateUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function runIdUtc(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function sourceRootSummary(source) {
  return {
    root: sourcePrefix(source),
    state: stateKey(source),
    structured: structuredPrefix(source),
    raw: rawPrefix(source),
    attachments: attachmentsPrefix(source),
    manifest: manifestPrefix(source),
  };
}
