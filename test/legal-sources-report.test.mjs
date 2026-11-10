import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_AFTER_HOURS,
  STALE_REASON_NO_SUCCESSFUL_RUN,
  buildLegalSourcesReport,
  freshnessHours,
  lastSuccessfulRunAt,
  persistReport,
  reportKey,
  shanghaiDateStr,
  shouldFail,
  sourceDbStats,
  staleness,
} from "../lib/legal-sources/report.js";
import { manifestKey, stateKey } from "../lib/legal-sources/storage.js";

const NOW = new Date("2026-10-06T02:00:00Z"); // 10:00 Asia/Shanghai
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

function fakeS3(objects = {}) {
  const puts = [];
  return {
    puts,
    async listObjects(_bucket, { prefix }) {
      const contents = Object.keys(objects)
        .filter((key) => key.startsWith(prefix) && key.endsWith(".manifest.json"))
        .map((key) => ({ key }));
      return { contents, truncated: false, continuationToken: undefined };
    },
    async getObject(_bucket, key) {
      const body = objects[key];
      if (body === undefined) return null;
      return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    },
    async putObject(_bucket, key, body) {
      puts.push({ key, body: String(body) });
      return { etag: "test-etag" };
    },
  };
}

function fakePg({ stats = {} } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("FROM legal_documents")) {
        const row = stats[params[0]] ?? {
          total_rows: 0, last_fetched_at: null, new_today: 0, new_7d: 0, effective_body_rows: 0,
        };
        return { rows: [row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function manifest({ finishedAt, complete = true, aborted = null, emitted = null }) {
  return {
    version: 1,
    runDate: finishedAt.slice(0, 10),
    runId: finishedAt.replace(/\D/g, "").slice(0, 14),
    finishedAt,
    coverage: { complete, emitted: emitted ?? (complete ? 5 : 2), failures: complete ? 0 : 7 },
    aborted,
  };
}

test("report series date follows the Asia/Shanghai wall clock, not UTC", () => {
  // The 06:00 cron instant: 22:00Z the previous UTC day.
  assert.equal(shanghaiDateStr(new Date("2026-10-05T22:00:00Z")), "2026-10-06");
  // 23:30 Shanghai is still the same day; 00:30 Shanghai already the next.
  assert.equal(shanghaiDateStr(new Date("2026-10-06T15:30:00Z")), "2026-10-06");
  assert.equal(shanghaiDateStr(new Date("2026-10-06T16:30:00Z")), "2026-10-07");
});

test("series key is dated so same-day reruns overwrite one file", () => {
  assert.equal(reportKey("2026-10-06"), "legal-sources/report/report-2026-10-06.json");
});

test("staleness: fresh run evidence is not stale even with zero new rows", () => {
  // Healthy no-op: the run itself is fresh; row counts never enter the verdict.
  const verdict = staleness({ now: NOW, freshnessAt: hoursAgo(2) });
  assert.equal(verdict.stale, false);
  assert.equal(verdict.stale_reason, null);
});

test("staleness: no successful run within 48h is stale, boundary is strict", () => {
  const atLine = staleness({ now: NOW, freshnessAt: hoursAgo(STALE_AFTER_HOURS) });
  assert.equal(atLine.stale, false);
  const pastLine = staleness({ now: NOW, freshnessAt: hoursAgo(STALE_AFTER_HOURS + 0.001) });
  assert.equal(pastLine.stale, true);
  assert.equal(pastLine.stale_reason, STALE_REASON_NO_SUCCESSFUL_RUN);
});

test("staleness: no run evidence at all is stale", () => {
  const verdict = staleness({ now: NOW, freshnessAt: null });
  assert.equal(verdict.stale, true);
  assert.equal(verdict.stale_reason, STALE_REASON_NO_SUCCESSFUL_RUN);
  assert.equal(freshnessHours({ now: NOW, freshnessAt: null }), null);
  assert.equal(freshnessHours({ now: NOW, freshnessAt: hoursAgo(2) }), 2);
});

test("lastSuccessfulRunAt picks the newest complete manifest, ignoring later aborted runs", () => {
  const manifests = [
    manifest({ finishedAt: hoursAgo(70) }),
    manifest({ finishedAt: hoursAgo(10), complete: false, aborted: { reason: "session/proxy failure" } }),
  ];
  assert.equal(lastSuccessfulRunAt(manifests), hoursAgo(70));
  assert.equal(lastSuccessfulRunAt(manifests.filter((m) => m.coverage.complete === false)), null);
  assert.equal(lastSuccessfulRunAt([]), null);
});

test("sourceDbStats aggregates read-only counts and the 50-char effective body ratio", async () => {
  const client = fakePg({
    stats: {
      "ccdi-supervisory-regulations": {
        total_rows: 3,
        last_fetched_at: new Date("2026-10-06T01:00:00Z"),
        new_today: 1,
        new_7d: 2,
        effective_body_rows: 2,
      },
    },
  });
  const stats = await sourceDbStats(client, "ccdi-supervisory-regulations");
  assert.deepEqual(stats, {
    total_rows: 3,
    last_fetched_at: "2026-10-06T01:00:00.000Z",
    new_today: 1,
    new_7d: 2,
    effective_body_rows: 2,
    effective_body_ratio: 0.6667,
  });
  const empty = await sourceDbStats(client, "gov-rules-library");
  assert.equal(empty.total_rows, 0);
  assert.equal(empty.effective_body_ratio, 0);
  assert.equal(empty.last_fetched_at, null);

  const q = client.queries[0];
  assert.deepEqual(q.params, ["ccdi-supervisory-regulations"]);
  assert.match(q.sql, /^SELECT/);
  assert.doesNotMatch(q.sql, /INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/);
});

test("report joins manifest audit, state liveness and DB stats; zero-new stays green", async () => {
  const govManifest = manifest({ finishedAt: hoursAgo(26) });
  const ccdiAborted = manifest({ finishedAt: hoursAgo(10), complete: false, aborted: { reason: "x" } });
  const ccdiComplete = manifest({ finishedAt: hoursAgo(70) });
  const s3 = fakeS3({
    [manifestKey("gov-rules-library", govManifest.runDate, govManifest.runId)]: govManifest,
    [stateKey("gov-rules-library")]: { version: 1, updatedAt: hoursAgo(2) }, // clean zero-new run
    [manifestKey("ccdi-supervisory-regulations", ccdiAborted.runDate, ccdiAborted.runId)]: ccdiAborted,
    [manifestKey("ccdi-supervisory-regulations", ccdiComplete.runDate, ccdiComplete.runId)]: ccdiComplete,
  });
  const pg = fakePg({
    stats: {
      "gov-rules-library": {
        total_rows: 100, last_fetched_at: hoursAgo(26), new_today: 0, new_7d: 3, effective_body_rows: 90,
      },
      "ccdi-supervisory-regulations": {
        total_rows: 6412, last_fetched_at: hoursAgo(60), new_today: 0, new_7d: 0, effective_body_rows: 439,
      },
    },
  });

  const report = await buildLegalSourcesReport({
    s3,
    bucket: "laws",
    sources: ["gov-rules-library", "ccdi-supervisory-regulations"],
    pgClient: pg,
    now: NOW,
  });

  assert.equal(report.date, "2026-10-06");
  assert.equal(report.bucket, "laws");

  // gov-rules: complete manifest 26h old but a zero-new run checkpointed state
  // 2h ago — fresh, not stale, despite new_today=0.
  const gov = report.sources["gov-rules-library"];
  assert.equal(gov.last_successful_run_at, hoursAgo(26));
  assert.equal(gov.freshness_at, hoursAgo(2));
  assert.equal(gov.coverage.state_updated_at, hoursAgo(2));
  assert.equal(gov.db.total_rows, 100);
  assert.equal(gov.db.new_today, 0);
  assert.equal(gov.db.new_7d, 3);
  assert.equal(gov.db.effective_body_ratio, 0.9);
  assert.equal(gov.stale, false);
  assert.equal(gov.stale_reason, null);

  // ccdi: aborted run 10h ago, no state save, last loaded row 60h ago — stale.
  const ccdi = report.sources["ccdi-supervisory-regulations"];
  assert.equal(ccdi.last_successful_run_at, hoursAgo(70));
  assert.equal(ccdi.freshness_at, hoursAgo(60));
  assert.equal(ccdi.stale, true);
  assert.equal(ccdi.stale_reason, STALE_REASON_NO_SUCCESSFUL_RUN);
  assert.deepEqual(report.stale_sources, ["ccdi-supervisory-regulations"]);
  // Existing coverage-gap semantics preserved (latest run not complete).
  assert.deepEqual(report.incomplete, ["ccdi-supervisory-regulations"]);

  // Dated series file is written and parseable.
  await persistReport(s3, "laws", report);
  assert.equal(s3.puts.length, 1);
  assert.equal(s3.puts[0].key, reportKey("2026-10-06"));
  const persisted = JSON.parse(s3.puts[0].body);
  assert.equal(persisted.date, "2026-10-06");
  assert.equal(persisted.sources["gov-rules-library"].stale, false);
});

test("report exit code: only 断流 fails the job, source-level incomplete stays visible but green", async () => {
  const sources = ["gov-rules-library", "mfa-treaty-library"];
  const objects = {
    [manifestKey("gov-rules-library", "2026-10-05", "r1")]: {
      version: 1, runId: "r1", runDate: "2026-10-05", finishedAt: hoursAgo(2),
      coverage: { complete: true, emitted: 3, failures: 0 }, aborted: null,
    },
  };
  const s3 = fakeS3(objects);
  // mfa has fresh loaded rows but no complete manifest — the accepted
  // out-of-scope attachment gap. Fresh, so not stale.
  const pg = fakePg({
    stats: {
      "gov-rules-library": { total_rows: 100, last_fetched_at: hoursAgo(2), new_today: 0, new_7d: 3, effective_body_rows: 99 },
      "mfa-treaty-library": { total_rows: 50, last_fetched_at: hoursAgo(3), new_today: 0, new_7d: 1, effective_body_rows: 50 },
    },
  });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources, pgClient: pg, now: NOW,
  });

  // Nothing is 断流: mfa is fresh despite carrying no complete manifest.
  assert.deepEqual(report.stale_sources, []);
  // The coverage gap is still reported, just not as an outage.
  assert.deepEqual(report.incomplete, ["mfa-treaty-library"]);

  assert.equal(shouldFail(report), false);
  assert.equal(shouldFail({ ...report, stale_sources: ["gov-rules-library"] }), true);
});

// ── 装载停滞（load_stalled）──────────────────────────────────────────────────
// 2026-11-10 实测：crawl 天天跑、state.json 天天新，于是 freshnessAt 用 max()
// 取到很新的值、整条源判为「新鲜」；而 load 侧被挂起，库里 mfa-treaty 35 天、
// party-regulation 33 天没有一行新数据。日报告连续一个月是绿的。

test("load_stalled: crawl 有新产出而库不跟着长 → 报装载停滞", async () => {
  const govManifest = manifest({ finishedAt: hoursAgo(2) });
  const s3 = fakeS3({
    [manifestKey("gov-rules-library", govManifest.runDate, govManifest.runId)]: govManifest,
    [stateKey("gov-rules-library")]: { version: 1, updatedAt: hoursAgo(2) },
  });
  const pg = fakePg({
    stats: {
      "gov-rules-library": {
        total_rows: 100, last_fetched_at: hoursAgo(24 * 33), new_today: 0, new_7d: 0, effective_body_rows: 90,
      },
    },
  });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources: ["gov-rules-library"], pgClient: pg, now: NOW,
  });
  const gov = report.sources["gov-rules-library"];
  assert.equal(gov.stale, false, "crawl 新鲜时不算断流（这是原有语义）");
  assert.equal(gov.load_stalled, true);
  assert.deepEqual(report.load_stalled_sources, ["gov-rules-library"]);
  assert.equal(shouldFail(report), true, "库里不进数必须让日报告红");
});

test("load_stalled: 安静的上游（无新 manifest）不误报", async () => {
  // 上游确实没有新文书：crawl 没有产出新 manifest，state 也未推进，
  // crawlAt 与 last_fetched_at 同时停留在很久以前 —— 两边同步，不是停滞。
  const s3 = fakeS3({});
  const pg = fakePg({
    stats: {
      "mfa-treaty-library": {
        total_rows: 50, last_fetched_at: hoursAgo(24 * 35), new_today: 0, new_7d: 0, effective_body_rows: 50,
      },
    },
  });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources: ["mfa-treaty-library"], pgClient: pg, now: NOW,
  });
  assert.equal(report.sources["mfa-treaty-library"].load_stalled, false);
  assert.deepEqual(report.load_stalled_sources, []);
});

test("load_stalled: 库里一行都没有且 crawl 有产出 → 也算停滞", async () => {
  const m = manifest({ finishedAt: hoursAgo(3) });
  const s3 = fakeS3({ [manifestKey("party-regulation-library", m.runDate, m.runId)]: m });
  const pg = fakePg({ stats: { "party-regulation-library": { total_rows: 0, last_fetched_at: null } } });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources: ["party-regulation-library"], pgClient: pg, now: NOW,
  });
  assert.equal(report.sources["party-regulation-library"].load_stalled, true);
});

test("load_stalled: 已断流时不重复计入（stale 优先）", async () => {
  const old = manifest({ finishedAt: hoursAgo(24 * 5) });
  const s3 = fakeS3({ [manifestKey("ccdi-supervisory-regulations", old.runDate, old.runId)]: old });
  const pg = fakePg({
    stats: { "ccdi-supervisory-regulations": { total_rows: 10, last_fetched_at: hoursAgo(24 * 10) } },
  });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources: ["ccdi-supervisory-regulations"], pgClient: pg, now: NOW,
  });
  assert.deepEqual(report.stale_sources, ["ccdi-supervisory-regulations"]);
  assert.deepEqual(report.load_stalled_sources, [], "断流已经表达了同一个事实，不重复报");
});

test("load_stalled: 零产出的干净跑批 + state 推进，不算装载停滞（安静上游）", async () => {
  // 这是判据最容易写错的地方：拿 state_updated_at 当锚点会把「每天跑、每天 0 新增」
  // 误判成装载停滞。实测样本 mfa-treaty：crawl/load 每天 success、rows=0、
  // state 每天推进，库里 35 天没新行 —— 上游确实没有新条约，不是故障。
  const zeroManifest = manifest({ finishedAt: hoursAgo(20), emitted: 0 });
  const s3 = fakeS3({
    [manifestKey("mfa-treaty-library", zeroManifest.runDate, zeroManifest.runId)]: zeroManifest,
    [stateKey("mfa-treaty-library")]: { version: 1, updatedAt: hoursAgo(2) },
  });
  const pg = fakePg({
    stats: {
      "mfa-treaty-library": {
        total_rows: 7408, last_fetched_at: hoursAgo(24 * 35), new_today: 0, new_7d: 0, effective_body_rows: 7000,
      },
    },
  });
  const report = await buildLegalSourcesReport({
    s3, bucket: "laws", sources: ["mfa-treaty-library"], pgClient: pg, now: NOW,
  });
  const mfa = report.sources["mfa-treaty-library"];
  assert.equal(mfa.stale, false, "零新增的干净跑批是新鲜");
  assert.equal(mfa.load_stalled, false, "零产出不构成装载停滞");
  assert.equal(shouldFail(report), false);
});
