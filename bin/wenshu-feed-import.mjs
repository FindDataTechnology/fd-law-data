#!/usr/bin/env node
// Monthly corpus package import — the 1e.5 replacement channel (see
// openspec/changes/archive/2026-09-29-wenshu-crawl-fleet-hardening task 1e.5).
//
// The account-based crawl route is abandoned. This entry consumes a
// channel-delivered monthly package (CSV, or a zip of CSVs), validates its
// shape, registers it in src_files (schema 'D', non-raw/ path so the loader's
// feed-precedence rule applies), loads judgments by DELETE→INSERT, and is
// idempotent. It NEVER fetches wenshu.court.gov.cn and NEVER assumes a
// package exists: --source is mandatory and there is no default path.
//
// Column contract: the historical schema-D package is a 17-column CSV with no
// IDs. Because the delivered header is channel-specific, --columns MUST list
// the exact header (comma-separated, in file order) — any mismatch fails loud
// with the expected shape rather than silently mis-loading rows.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { unzipSync } from "fflate";
import { loadConfig } from "../lib/config.js";
import { pickDocId } from "../lib/wenshu/ids.js";

// Same 17 catalog columns as lib/wenshu/crawler.js DICT_COLS (dict order).
export const DICT_COLS = [
  "案号", "标题", "法院", "案由", "省", "市",
  "案件类型", "文书类型", "审理程序", "案例级别", "法院级别", "法条",
  "判决时间", "发布时间", "受理时间", "判决年份", "判决结果",
];
export const JUDGMENT_COLS = [
  "doc_id", "id_origin", "案号", "标题",
  "法院引用", "案由引用", "省引用", "市引用", "案件类型引用", "文书类型引用",
  "审理程序引用", "案例级别引用", "法院级别引用", "法条引用",
  "判决时间", "发布时间", "受理时间", "判决年份", "判决结果", "正文形态",
  "block_key", "block_ordinal", "src_id",
];
const DICT_COLUMNS = [
  ["法院", "法院引用"], ["案由", "案由引用"], ["省", "省引用"], ["市", "市引用"],
  ["案件类型", "案件类型引用"], ["文书类型", "文书类型引用"], ["审理程序", "审理程序引用"],
  ["案例级别", "案例级别引用"], ["法院级别", "法院级别引用"], ["法条", "法条引用"],
];
const qident = (c) => (/^[A-Za-z0-9_]+$/.test(c) ? c : `"${c}"`);
const keyOf = (col, txt) => `${col} ${txt}`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

/** RFC4180-ish CSV parse; handles quoted commas/newlines via a small state machine. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Validate header against the declared contract; throws with the expected shape. */
export function validateHeader(header, expected) {
  if (!Array.isArray(header) || header.length !== expected.length) {
    throw new Error(`schema-D shape mismatch: header has ${header?.length ?? 0} columns, expected ${expected.length} (${expected.join(",")})`);
  }
  const differs = expected.some((c, i) => header[i] !== c);
  if (differs) {
    throw new Error(`schema-D shape mismatch: columns differ — got [${header.join(",")}], expected [${expected.join(",")}]`);
  }
}

export function rowsFromCsv(text, expectedColumns) {
  const raw = parseCsv(text);
  if (!raw.length) throw new Error("empty package: no header row");
  validateHeader(raw[0], expectedColumns);
  const out = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    if (cells.length === 1 && cells[0] === "") continue; // trailing blank line
    if (cells.length !== expectedColumns.length) {
      throw new Error(`row ${i + 1}: ${cells.length} cells, expected ${expectedColumns.length}`);
    }
    const r = {};
    expectedColumns.forEach((c, j) => { r[c] = cells[j] || null; });
    r.docId = pickDocId({ 案号: r.案号, 法院: r.法院, 判决时间: r.判决时间 });
    out.push(r);
  }
  return out;
}

async function dictRef(client, memo, col, txt) {
  const mk = keyOf(col, txt);
  if (memo.has(mk)) return memo.get(mk);
  const ins = await client.query(
    `INSERT INTO dict_texts ("列", ref_key, txt)
     SELECT $1, coalesce(max(ref_key),0)+1, $2 FROM dict_texts WHERE "列"=$1
     ON CONFLICT ("列",txt) DO NOTHING RETURNING ref_key`,
    [col, txt],
  );
  let ref = ins.rows.length ? ins.rows[0].ref_key : null;
  if (ref == null) {
    const sel = await client.query(`SELECT ref_key FROM dict_texts WHERE "列"=$1 AND txt=$2`, [col, txt]);
    ref = sel.rows[0]?.ref_key ?? null;
  }
  if (ref == null) throw new Error(`dict_texts upsert lost row (${col})`);
  memo.set(mk, ref);
  return ref;
}

async function registerSrcFile(client, key, year, month) {
  const nextId = (await client.query("SELECT coalesce(max(src_id),0)+1 AS src_id FROM src_files")).rows[0].src_id;
  const ins = await client.query(
    `INSERT INTO src_files (src_id, path, schema, year, month) VALUES ($1,$2,'D',$3,$4)
     ON CONFLICT (path) DO NOTHING RETURNING src_id`,
    [nextId, key, year, month],
  );
  if (ins.rows.length) return ins.rows[0].src_id;
  const sel = await client.query("SELECT src_id FROM src_files WHERE path = $1", [key]);
  const srcId = sel.rows[0]?.src_id;
  if (srcId == null) throw new Error(`${key}: src_files registration lost its row`);
  return srcId;
}

/** Core import (injectable for tests). Returns a summary; never touches the site. */
export async function importPackage({ client, key, text, expectedColumns, year, month }) {
  const rows = rowsFromCsv(text, expectedColumns);
  const srcId = await registerSrcFile(client, key, year, month);
  const memo = new Map();
  for (const r of rows) {
    for (const [col] of DICT_COLUMNS) {
      const txt = r[col];
      if (txt != null && txt !== "" && !memo.has(keyOf(col, txt))) {
        await dictRef(client, memo, col, String(txt));
      }
    }
  }
  const refOf = (col, val) => (val == null || val === "" ? null : memo.get(keyOf(col, val)));
  const tuples = rows.map((r) => [
    r.docId.doc_id, r.docId.id_origin, r.案号 ?? null, r.标题 ?? null,
    ...DICT_COLUMNS.map(([col]) => refOf(col, r[col])),
    r.判决时间 ?? null, r.发布时间 ?? null, r.受理时间 ?? null,
    r.判决年份 == null ? null : Number(r.判决年份), r.判决结果 ?? null,
    "text", null, null, srcId,
  ]);
  const colList = JUDGMENT_COLS.map(qident).join(",");
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM judgments WHERE src_id=$1", [srcId]);
    let inserted = 0;
    for (let i = 0; i < tuples.length; i += 500) {
      const part = tuples.slice(i, i + 500);
      const params = [];
      const values = part.map((t, j) => {
        const ph = t.map((_, k) => { params.push(t[k]); return `$${j * t.length + k + 1}`; });
        return `(${ph.join(",")})`;
      });
      const res = await client.query(
        `INSERT INTO judgments (${colList}) VALUES ${values.join(",")} ON CONFLICT (doc_id) DO NOTHING`, params);
      inserted += typeof res.rowCount === "number" ? res.rowCount : part.length;
    }
    await client.query("COMMIT");
    return { key, srcId, rows: rows.length, inserted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  const source = arg("source");
  const columns = arg("columns");
  const year = Number(arg("year"));
  const month = Number(arg("month"));
  if (!source || source === true) throw new Error("--source <path|zip> is mandatory (no default path; channel delivery only)");
  if (!columns || columns === true) throw new Error("--columns <comma-separated header> is mandatory (schema-D contract; see DICT_COLS)");
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("--year / --month required (integers, month 1..12)");
  }
  const expectedColumns = columns.split(",").map((s) => s.trim()).filter(Boolean);
  const buf = readFileSync(source);
  let texts;
  if (source.toLowerCase().endsWith(".zip")) {
    const files = unzipSync(new Uint8Array(buf));
    texts = Object.entries(files)
      .filter(([name]) => name.toLowerCase().endsWith(".csv"))
      .map(([name, data]) => ({ name, text: Buffer.from(data).toString("utf8") }));
    if (!texts.length) throw new Error("zip contains no .csv files");
  } else {
    texts = [{ name: basename(source), text: buf.toString("utf8") }];
  }
  const cfg = loadConfig();
  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();
  try {
    const summaries = [];
    for (const { name, text } of texts) {
      const key = `${year}/${name}`;
      const res = await importPackage({ client, key, text, expectedColumns, year, month });
      summaries.push(res);
      console.error(`[wenshu-feed-import] ${key}: ${res.rows} row(s) -> src_id ${res.srcId}`);
    }
    console.log(JSON.stringify({ packages: summaries.length, summaries }, null, 1));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await main(); }
  catch (err) { console.error(`[wenshu-feed-import] FATAL: ${err.message}`); process.exitCode = 1; }
}
