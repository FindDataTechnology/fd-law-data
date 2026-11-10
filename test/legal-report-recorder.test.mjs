import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * legal-sources-report 记录器（chart 里 report.args 的那段 sh + node -e）。
 *
 * 背景：这个记录器的真身一直只存在于**已废弃的** k8s/legal-source-crawl-cronjobs.yaml，
 * 而 chart 里只是裸跑脚本 —— 谁 apply chart 谁就把 crawl_runs 里那行记录弄丢。
 * 2026-11-10 把它收编进 chart，并顺手补上 load_stalled。
 *
 * 这里钉两件事：
 *   1. 镜像还没更新时（报告里没有 load_stalled_sources），记录结果必须与旧版
 *      **逐字节一致** —— 收编不能改变既有观测口径；
 *   2. 报告一旦带上 load_stalled_sources，就必须落进 status 与 error_head，
 *      否则这个新判据在 crawl_runs 里永远看不见。
 */

// chart 是**相邻检出**（~/finddata/helm-law-scraw），不是本仓的一部分。
// 用 FD_LAW_CHART_DIR 可显式指定；找不到就 skip —— 不能 fail：
// 公开镜像仓 scs001/fd-law-data 只 checkout 本仓，它的 `npm test` 是出片前置，
// 在这里硬失败会把整条出片卡死（2026-11-11 实测：/tmp/mirror 里直接报
// `path "/private/tmp/helm-law-scraw" not found`）。
const CHART = process.env.FD_LAW_CHART_DIR
  ? path.resolve(process.env.FD_LAW_CHART_DIR)
  : path.resolve(import.meta.dirname, "..", "..", "helm-law-scraw");
const HAVE_HELM = (() => {
  try { execFileSync("helm", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const HAVE_CHART = fs.existsSync(path.join(CHART, "Chart.yaml"));
const SKIP_REASON = !HAVE_HELM
  ? "helm 不可用"
  : (!HAVE_CHART ? `未找到 chart（${CHART}）；设 FD_LAW_CHART_DIR 或与该仓同级检出` : false);

function recorderFromChart() {
  const out = execFileSync("helm", ["template", "law-craw", CHART, "--namespace", "scraw"], { encoding: "utf8" });
  // 只取 legal-sources-report 这个 CronJob 的容器 args
  const doc = out.split(/^---$/m).find((d) => d.includes("name: legal-sources-report") && d.includes("kind: CronJob"));
  const argsBlock = doc.split("args:")[1];
  const first = argsBlock.split("\n").slice(1).join("\n");
  // 用 YAML 里的 | 块标量：去掉公共缩进，遇下一个同级 key 结束
  const lines = [];
  let indent = null;
  for (const raw of first.split("\n")) {
    if (!raw.trim()) { lines.push(""); continue; }
    const cur = raw.match(/^\s*/)[0].length;
    if (indent === null) { indent = cur; }
    if (cur < indent) break;
    lines.push(raw.slice(indent));
  }
  return lines.join("\n").trimEnd();
}

const CHART_SCRIPT = (HAVE_HELM && HAVE_CHART) ? recorderFromChart() : null;

/** 旧记录器：收编前现场跑的那一份（逐字留档，作为向后兼容的对照组）。 */
const LEGACY_SCRIPT = `export FD_RUN_STARTED=$(date +%s)
node bin/legal-sources-report.mjs > /tmp/report.json 2>/tmp/report.err
RC=$?
node -e '
  const fs = require("fs");
  const { Client } = require("pg");
  const rc = Number(process.argv[1]);
  let report = {};
  try { report = JSON.parse(fs.readFileSync("/tmp/report.json", "utf8")); } catch {}
  const rows = Object.values(report.sources || {}).reduce(
    (n, s) => n + (Number(s && s.db && s.db.total_rows) || 0), 0);
  const stale = (report.stale_sources || []).join(",");
  const status = rc === 0 && !stale ? "success" : "failed";
  const err = [rc ? "exit=" + rc : "", stale ? "stale=" + stale : "",
    fs.existsSync("/tmp/report.err") ? fs.readFileSync("/tmp/report.err", "utf8").slice(-200) : ""]
    .filter(Boolean).join(" | ").slice(0, 500);
  const url = process.env.FD_CRAWL_DB_URL;
  const t0 = Number(process.env.FD_RUN_STARTED) || Math.floor(Date.now() / 1000);
  const t1 = Math.floor(Date.now() / 1000);
  if (!url) { console.error("report_special_run: no FD_CRAWL_DB_URL; run not recorded"); process.exit(0); }
  (async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query(
      "INSERT INTO crawl_runs (source, kind, status, started_at, finished_at, rows_written, error_head) VALUES ($1,$2,$3,to_timestamp($4),to_timestamp($5),$6,$7)",
      ["legal-sources-report", "special-job", status, t0, t1, rows, err || null]);
    await c.end();
    console.log("report_special_run: legal-sources-report", status, "rows=" + rows);
  })().catch(e => { console.error("report_special_run: psql report failed:", e.message); process.exit(0); });
' "$RC" || true
exit $RC`;

function sandbox(script, { rc, report, stderr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrr-"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "pg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "legal-sources-report.mjs"),
    `process.stderr.write(${JSON.stringify(stderr)});\nconsole.log(${JSON.stringify(JSON.stringify(report))});\nprocess.exit(${rc});\n`);
  fs.writeFileSync(path.join(dir, "node_modules", "pg", "package.json"), '{"name":"pg","main":"index.js"}');
  fs.writeFileSync(path.join(dir, "node_modules", "pg", "index.js"), `
    const fs = require("fs");
    class Client {
      async connect() {}
      async query(sql, params) { fs.writeFileSync(process.env.REC_OUT, JSON.stringify({ sql, params })); return { rows: [] }; }
      async end() {}
    }
    module.exports = { Client };`);
  fs.writeFileSync(path.join(dir, "recorder.sh"), script);
  for (const p of ["/tmp/report.json", "/tmp/report.err"]) fs.rmSync(p, { force: true });
  const recOut = path.join(dir, "rec.json");
  // 记录器最后一行是 `exit $RC` —— 报告自身失败（rc=2）是**被测场景**，不是测试故障。
  try {
    execFileSync("sh", ["recorder.sh"], {
      cwd: dir,
      env: { ...process.env, FD_CRAWL_DB_URL: "postgres://stub/db", FD_RUN_STARTED: "1700000000", REC_OUT: recOut },
      stdio: "ignore",
    });
  } catch { /* 非零退出即预期路径，判定只看落库参数 */ }
  const { params } = JSON.parse(fs.readFileSync(recOut, "utf8"));
  return { source: params[0], kind: params[1], status: params[2], rows: params[5], error_head: params[6] };
}

const CASES = [
  { name: "rc=0 无 stale", rc: 0, report: { sources: { s: { db: { total_rows: 100 } } }, stale_sources: [] }, stderr: "" },
  { name: "rc=2 有 stale", rc: 2, report: { sources: { s: { db: { total_rows: 47309 } } }, stale_sources: ["rmfyalk-case-library"] }, stderr: "" },
  { name: "报告不可解析", rc: 0, report: {}, stderr: "" },
  { name: "rc=1 带 stderr", rc: 1, report: { sources: {}, stale_sources: [] }, stderr: "boom: something failed\n" },
];

for (const c of CASES) {
  test(`记录器向后兼容：${c.name} 时新脚本与旧脚本逐字段一致`, { skip: SKIP_REASON }, () => {
    const old = sandbox(LEGACY_SCRIPT, c);
    const cur = sandbox(CHART_SCRIPT, c);
    assert.deepEqual(cur, old);
  });
}

test("记录器：报告带 load_stalled_sources 时必须落进 status 与 error_head", { skip: SKIP_REASON }, () => {
  const out = sandbox(CHART_SCRIPT, {
    rc: 0,
    report: { sources: { s: { db: { total_rows: 10 } } }, stale_sources: [], load_stalled_sources: ["gov-rules-library"] },
    stderr: "",
  });
  assert.equal(out.status, "failed");
  assert.equal(out.error_head, "load_stalled=gov-rules-library");
});

test("旧记录器看不懂 load_stalled_sources（这正是收编要补的能力）", () => {
  const out = sandbox(LEGACY_SCRIPT, {
    rc: 0,
    report: { sources: {}, stale_sources: [], load_stalled_sources: ["gov-rules-library"] },
    stderr: "",
  });
  assert.equal(out.status, "success", "旧记录器对它视而不见");
  assert.equal(out.error_head, null);
});
