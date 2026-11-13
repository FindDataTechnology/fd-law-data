import test from "node:test";
import assert from "node:assert/strict";
import {
  sourcePrefix,
  stateKey,
  structuredPartKey,
  manifestKey,
  rawKey,
  attachmentKey,
  safeSegment,
  sourceRootSummary,
} from "../lib/legal-sources/storage.js";

test("legal source storage keys stay isolated and deterministic", () => {
  assert.equal(sourcePrefix("mfa-treaty-library"), "legal-sources/mfa-treaty-library");
  assert.equal(stateKey("mfa-treaty-library"), "legal-sources/mfa-treaty-library/state.json");
  assert.equal(
    structuredPartKey("mfa-treaty-library", "20260923093000", 2),
    "legal-sources/mfa-treaty-library/structured/run-20260923093000-part002.jsonl",
  );
  assert.equal(
    manifestKey("mfa-treaty-library", "2026-09-23", "20260923000000"),
    "legal-sources/mfa-treaty-library/manifest/run-2026-09-23-20260923000000.manifest.json",
  );
  assert.equal(
    rawKey("mfa-treaty-library", "objid/1", "page.html"),
    "legal-sources/mfa-treaty-library/raw/objid%2F1/page.html",
  );
  assert.equal(
    attachmentKey("mfa-treaty-library", "1", "条约文本.pdf"),
    "legal-sources/mfa-treaty-library/attachments/1/%E6%9D%A1%E7%BA%A6%E6%96%87%E6%9C%AC.pdf",
  );
});

test("structured part keys embed the run id so a later run cannot overwrite an earlier one", () => {
  const first = structuredPartKey("ccdi-supervisory-regulations", "20261006101500", 1);
  const second = structuredPartKey("ccdi-supervisory-regulations", "20261007090000", 1);
  assert.notEqual(first, second);
  // Same run, later part still sorts later within the run.
  const sameRunLaterPart = structuredPartKey("ccdi-supervisory-regulations", "20261006101500", 2);
  assert.ok(sameRunLaterPart.localeCompare(first) > 0);
});

test("key-order fold stays latest-wins: legacy keys first, then runs by id", () => {
  // The loader folds parts sorted by key (localeCompare in legal-source-load).
  // Legacy day-only keys predate the run-id layout and must fold first; runs
  // with id-bearing keys must fold in chronological order so the newest run
  // wins per source_id.
  const prefix = "legal-sources/ccdi-supervisory-regulations/structured/";
  const keys = [
    `${prefix}run-20261007090000-part001.jsonl`, // newest run
    `${prefix}run-2026-10-06-part001.jsonl`, // legacy day-only key
    `${prefix}run-20261006101500-part002.jsonl`, // same run, part 2
    `${prefix}run-20261006101500-part001.jsonl`, // same run, part 1
    `${prefix}run-2026-09-23-part001.jsonl`, // older legacy key
  ];
  const expected = [
    `${prefix}run-2026-09-23-part001.jsonl`,
    `${prefix}run-2026-10-06-part001.jsonl`,
    `${prefix}run-20261006101500-part001.jsonl`,
    `${prefix}run-20261006101500-part002.jsonl`,
    `${prefix}run-20261007090000-part001.jsonl`,
  ];
  // Both the loader's collation and plain byte order must produce this order.
  assert.deepEqual([...keys].sort((a, b) => a.localeCompare(b)), expected);
  assert.deepEqual([...keys].sort(), expected);

  const rows = [
    [expected[0], { source_id: "1", content_hash: "legacy" }],
    [expected[2], { source_id: "1", content_hash: "run-101500" }],
    [expected[4], { source_id: "1", content_hash: "run-090000" }],
  ];
  const folded = new Map();
  for (const [key, row] of [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    folded.set(row.source_id, row.content_hash);
  }
  assert.equal(folded.get("1"), "run-090000");
});

test("structured part keys reject malformed run ids instead of colliding", () => {
  assert.throws(() => structuredPartKey("mfa-treaty-library", "2026-09-23", 1), /invalid legal source run id/);
  assert.throws(() => structuredPartKey("mfa-treaty-library", "", 1), /invalid legal source run id/);
  assert.throws(() => structuredPartKey("mfa-treaty-library", null, 1), /invalid legal source run id/);
});

test("safeSegment removes path separators and caps long names", () => {
  assert.equal(safeSegment("a/b\\c"), "a%2Fb%5Cc");
  assert.equal(safeSegment("").length > 0, true);
  assert.ok(safeSegment("x".repeat(500)).length <= 180);
});

test("sourceRootSummary names the five layout roots", () => {
  const summary = sourceRootSummary("rmfyalk-case-library");
  assert.deepEqual(Object.keys(summary).sort(), ["attachments", "manifest", "raw", "root", "state", "structured"]);
  assert.ok(summary.structured.startsWith(`${summary.root}/structured/`));
});

test("invalid source ids fail loudly", () => {
  assert.throws(() => sourcePrefix("../escape"), /invalid legal source id/);
  assert.throws(() => sourcePrefix(""), /invalid legal source id/);
});

// state.json 是这一族里唯一随语料单调增长的对象（gov-rules 实测 1.43MB），
// 而 s3.js 的 timeoutMs 是**总预算且包含 body 读**。实测链路吞吐可掉到
// 0.02MB/s ⇒ 1.4MB 需要 70 秒，默认 60s 必然失败。
//
// 判据钉在**行为**上（loadState 实际传给 getObject 的值），不钉常量字面量：
// 常量改小到覆盖不了实测最坏值就该红，改大不该红。
test("state.json 的读取预算覆盖实测最坏的链路吞吐", async () => {
  const { loadState } = await import("../lib/legal-sources/state.js");
  const { stateKey, STATE_READ_TIMEOUT_MS } = await import("../lib/legal-sources/storage.js");

  const calls = [];
  const s3 = {
    async getObject(bucket, key, opts) {
      calls.push({ bucket, key, opts });
      return Buffer.from(JSON.stringify({ source: "gov-rules-library", hashes: {}, failures: {} }));
    },
  };
  await loadState(s3, "laws", "gov-rules-library");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, stateKey("gov-rules-library"));
  const budget = calls[0].opts?.timeoutMs;
  assert.equal(typeof budget, "number", "loadState 必须显式给 state 读取一个预算，不能吃 60s 默认值");

  // 实测：gov-rules state.json 1430410B，链路最差 0.02MB/s ⇒ 约 70s。
  // 预算至少要能容下「比实测最差再差 4 倍」的那一档，否则同一形态必然复发。
  const measuredWorstBytes = 1430410;
  const measuredWorstBytesPerSec = 0.02 * 1024 * 1024;
  const measuredWorstMs = (measuredWorstBytes / measuredWorstBytesPerSec) * 1000;
  assert.ok(
    budget >= measuredWorstMs * 4,
    `state 读取预算 ${budget}ms 覆盖不了实测最坏 ${Math.round(measuredWorstMs)}ms 的 4 倍余量`,
  );
  assert.equal(budget, STATE_READ_TIMEOUT_MS);
});
