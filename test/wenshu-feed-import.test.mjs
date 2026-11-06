// Monthly corpus package import (1e.5 channel) — unit tests with a synthetic
// 17-column schema-D fixture. No production data, no site access, no real PG.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DICT_COLS, JUDGMENT_COLS, parseCsv, validateHeader, rowsFromCsv, importPackage,
} from "../bin/wenshu-feed-import.mjs";
import { load } from "../lib/wenshu/loader.js";
import { LocalS3 } from "./fixtures/local-s3.mjs";

const norm = (t) => t.replace(/\s+/g, " ").trim();

const HEADER = DICT_COLS.join(",");
function csvLines(...rows) {
  return [HEADER, ...rows].join("\n") + "\n";
}
function dataLine(over = {}) {
  const base = {
    案号: "（2026）京01民初1号", 标题: "样例案件", 法院: "北京市第一中级人民法院",
    案由: "买卖合同纠纷", 省: "北京市", 市: "北京市", 案件类型: "民事案件",
    文书类型: "判决书", 审理程序: "一审", 案例级别: "普通案例", 法院级别: "中级法院",
    法条: "中华人民共和国民法典", 判决时间: "2026-01-15", 发布时间: "2026-01-20",
    受理时间: "2025-12-01", 判决年份: "2026", 判决结果: "支持",
  };
  const r = { ...base, ...over };
  return DICT_COLS.map((c) => r[c] ?? "").join(",");
}

// Minimal in-memory PG covering exactly the SQL the importer emits.
class FakePG {
  constructor(seed = {}) {
    this.srcFiles = (seed.srcFiles ?? []).map((r) => ({ ...r }));
    this.dictTexts = (seed.dictTexts ?? []).map((r) => ({ ...r }));
    this.judgments = (seed.judgments ?? []).map((r) => ({ ...r }));
    this.log = [];
  }
  async query(text, params = []) {
    this.log.push({ text: norm(text), params });
    const t = norm(text);
    const empty = () => ({ rows: [], rowCount: 0 });
    if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return empty();
    if (t.startsWith("SELECT coalesce(max(src_id),0)+1 AS src_id FROM src_files")) {
      const next = this.srcFiles.reduce((mx, r) => Math.max(mx, r.src_id), 0) + 1;
      return { rows: [{ src_id: next }], rowCount: 1 };
    }
    if (t.startsWith("INSERT INTO src_files")) {
      const [src_id, path, year, month] = params;
      if (this.srcFiles.some((r) => r.path === path)) return empty();
      this.srcFiles.push({ src_id, path, schema: "D", year, month });
      return { rows: [{ src_id }], rowCount: 1 };
    }
    if (t.startsWith("SELECT src_id FROM src_files WHERE path")) {
      const hit = this.srcFiles.find((r) => r.path === params[0]);
      return { rows: hit ? [{ src_id: hit.src_id }] : [], rowCount: hit ? 1 : 0 };
    }
    if (t.startsWith("INSERT INTO dict_texts")) {
      const [col, txt] = params;
      if (this.dictTexts.some((r) => r["列"] === col && r.txt === txt)) return empty();
      const ref_key = this.dictTexts.filter((r) => r["列"] === col).reduce((mx, r) => Math.max(mx, r.ref_key), 0) + 1;
      this.dictTexts.push({ "列": col, ref_key, txt });
      return { rows: [{ ref_key }], rowCount: 1 };
    }
    if (t.startsWith("SELECT ref_key FROM dict_texts")) {
      const hit = this.dictTexts.find((r) => r["列"] === params[0] && r.txt === params[1]);
      return { rows: hit ? [{ ref_key: hit.ref_key }] : [], rowCount: hit ? 1 : 0 };
    }
    if (t.startsWith("DELETE FROM judgments")) {
      const before = this.judgments.length;
      this.judgments = this.judgments.filter((r) => r.src_id !== params[0]);
      return { rows: [], rowCount: before - this.judgments.length };
    }
    if (t.startsWith("INSERT INTO judgments")) {
      const cols = t.match(/^INSERT INTO judgments \(([^)]+)\) VALUES /)[1].split(",").map((s) => s.trim().replace(/"/g, ""));
      const count = params.length / cols.length;
      let inserted = 0;
      for (let i = 0; i < count; i++) {
        const row = {};
        cols.forEach((c, k) => { row[c] = params[i * cols.length + k]; });
        if (this.judgments.some((r) => r.doc_id === row.doc_id)) continue;
        this.judgments.push(row);
        inserted++;
      }
      return { rows: [], rowCount: inserted };
    }
    if (t.startsWith("SELECT 1 FROM src_files")) {
      const [year, month] = params;
      const hit = this.srcFiles.some((r) => r.schema === "D" && r.year === year && r.month === month && !String(r.path).startsWith("raw/"));
      return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    throw new Error(`FakePG: unmatched query: ${t}`);
  }
}

test("parseCsv handles quoted commas and CRLF", () => {
  const rows = parseCsv('a,b\r\n"x,y",z\r\n');
  assert.deepEqual(rows, [["a", "b"], ["x,y", "z"]]);
});

test("validateHeader accepts the 17-column contract and rejects drift", () => {
  assert.doesNotThrow(() => validateHeader(DICT_COLS, DICT_COLS));
  assert.throws(() => validateHeader(["a", "b"], DICT_COLS), /schema-D shape mismatch/);
  assert.throws(() => validateHeader(DICT_COLS.slice(0, 16), DICT_COLS), /expected 17/);
});

test("rowsFromCsv derives doc_id, rejects bad row width and empty packages", () => {
  const rows = rowsFromCsv(csvLines(dataLine(), dataLine({ 案号: "（2026）京01民初2号" })), DICT_COLS);
  assert.equal(rows.length, 2);
  assert.match(rows[0].docId.doc_id, /^[0-9a-f]{32}$/);
  assert.equal(rows[0].docId.id_origin, "derived");
  assert.throws(() => rowsFromCsv(csvLines("too,few"), DICT_COLS), /2 cells, expected 17/);
  assert.throws(() => rowsFromCsv("", DICT_COLS), /no header row/);
});

test("importPackage registers a D-schema feed row and loads idempotently", async () => {
  const pg = new FakePG();
  const text = csvLines(dataLine(), dataLine({ 案号: "（2026）京01民初2号" }));
  const a = await importPackage({ client: pg, key: "2026/2026年01月裁判文书.csv", text, expectedColumns: DICT_COLS, year: 2026, month: 1 });
  assert.equal(a.rows, 2);
  assert.equal(a.inserted, 2);
  assert.equal(pg.srcFiles.length, 1);
  assert.equal(pg.srcFiles[0].schema, "D");
  assert.equal(pg.srcFiles[0].path, "2026/2026年01月裁判文书.csv");
  assert.equal(pg.srcFiles[0].year, 2026);
  assert.equal(pg.srcFiles[0].month, 1);
  assert.ok(!pg.srcFiles[0].path.startsWith("raw/"), "feed path must be non-raw/ for precedence");
  assert.equal(pg.judgments.length, 2);
  assert.equal(pg.judgments[0].正文形态, "text");
  assert.equal(pg.judgments[0].block_key, null);

  const b = await importPackage({ client: pg, key: "2026/2026年01月裁判文书.csv", text, expectedColumns: DICT_COLS, year: 2026, month: 1 });
  assert.equal(b.srcId, a.srcId, "same path -> same src_id");
  assert.equal(pg.srcFiles.length, 1, "no duplicate registration");
  assert.equal(pg.judgments.length, 2, "re-run leaves no duplicates");
  assert.equal(b.inserted, 2, "DELETE then INSERT is idempotent at row level");
});

test("importPackage never emits site requests and fails loud on malformed shape", async () => {
  const pg = new FakePG();
  await assert.rejects(
    () => importPackage({ client: pg, key: "2026/bad.csv", text: "a,b\n1,2\n", expectedColumns: DICT_COLS, year: 2026, month: 2 }),
    /schema-D shape mismatch/,
  );
  assert.equal(pg.srcFiles.length, 0, "no registration on malformed package");
  assert.equal(pg.judgments.length, 0, "no load on malformed package");
  assert.ok(pg.log.every((q) => !/wenshu\.court\.gov\.cn/i.test(q.text)), "no SQL references the site");
});

test("feed precedence: a registered month makes the loader skip crawled daily files", async () => {
  const pg = new FakePG();
  const text = csvLines(dataLine());
  await importPackage({ client: pg, key: "2026/2026年01月裁判文书.csv", text, expectedColumns: DICT_COLS, year: 2026, month: 1 });
  const s3 = new LocalS3();
  // A raw/ daily file for the same month must be skipped at load time.
  const daily = "raw/2026/01/crawl-2026-01-15.jsonl";
  await s3.putObject("wenshu", daily, JSON.stringify({ docId: "a".repeat(32), id_origin: "native", 案号: "x", 标题: "y", 判决时间: "2026-01-15" }) + "\n");
  const summary = await load({ s3, bucket: "wenshu", pg });
  assert.ok(summary.skippedMonths.includes("2026-01"), `expected skipped month, got ${JSON.stringify(summary.skippedMonths)}`);
  assert.equal(pg.judgments.length, 1, "feed rows untouched by the skipped daily file");
});
