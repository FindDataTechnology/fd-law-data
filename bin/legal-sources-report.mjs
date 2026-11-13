#!/usr/bin/env node
// Daily legal-sources report. Reads the object-storage run audit (coverage
// manifests + state.json) and law_db.legal_documents (read-only aggregates),
// prints the JSON, and appends a dated file to the legal-sources/report/
// series in the laws bucket. It never contacts any upstream site.
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { buildLegalSourcesReport, persistReport, shouldFail } from "../lib/legal-sources/report.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";

// 未点亮（CronJob 挂起）的源清单，由部署清单渲染成 env 传入（逗号分隔）。
// 不内省集群：本任务只有 PG 只读凭据，没有也不该有集群权限。
function pausedSourcesFromEnv(env = process.env, known = [...SOURCE_ADAPTERS.keys()]) {
  const raw = String(env.LEGAL_PAUSED_SOURCES || "");
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const knownSet = new Set(known);
  const unknown = names.filter((n) => !knownSet.has(n));
  // 拼写错误会让「暂停」静默不生效、报告继续每天红 —— 宁可吵一句。
  if (unknown.length) {
    console.error(`[legal-sources-report] LEGAL_PAUSED_SOURCES 含未知源名，已忽略：${unknown.join(",")}`);
  }
  return names.filter((n) => knownSet.has(n));
}

export async function main() {
  const cfg = loadConfig();
  const s3 = createS3({
    endpoint: cfg.s3Endpoint,
    accessKey: cfg.s3AccessKey,
    secretKey: cfg.s3SecretKey,
    region: cfg.s3Region,
  });
  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();
  try {
    const report = await buildLegalSourcesReport({
      s3,
      bucket: cfg.lawsBucket,
      sources: [...SOURCE_ADAPTERS.keys()],
      pgClient: client,
      pausedSources: pausedSourcesFromEnv(),
    });
    console.log(JSON.stringify(report, null, 1));
    // Same-day reruns overwrite the same dated file (idempotent series key).
    await persistReport(s3, cfg.lawsBucket, report);
    if (shouldFail(report)) process.exitCode = 2;
    return report;
  } finally {
    await client.end();
  }
}

// undici 全局 keep-alive 连接池在部分端点（如直连 RustFS）下会让事件循环滞留，
// 工作完成后任务永不退出（k8s 侧表现为 deadline 假失败）。stdout 冲刷后确定性退出。
async function exitCleanly() {
  await new Promise((resolve) => process.stdout.write("", () => resolve()));
  process.exit(process.exitCode ?? 0);
}

function invokedDirectly() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (err) {
    console.error(`[legal-sources-report] FATAL: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
  await exitCleanly();
}
