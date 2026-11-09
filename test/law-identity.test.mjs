import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDocNumber,
  findCrossGenerationDuplicate,
  resolveBatchCategory,
} from "../lib/law/identity.js";

/** Minimal fake pg client: records queries, returns the canned result. */
function fakeClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("guard reports a duplicate when a canonical effective twin exists", async () => {
  const client = fakeClient([{ "?column?": 1 }]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "中华人民共和国网络安全法" }), true);
  const { sql, params } = client.calls[0];
  assert.match(sql, /lower\(title\) = lower\(\$1\)/);
  assert.match(sql, /status = '有效'/);
  assert.deepEqual(params[0], "中华人民共和国网络安全法");
  assert.deepEqual(params[1], ["重下载", "新法速递"]);
});

test("guard answers false when nothing matches", async () => {
  const client = fakeClient([]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "某新法" }), false);
});

test("guard skips the query entirely for a missing title", async () => {
  const client = fakeClient([{ "?column?": 1 }]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "" }), false);
  assert.equal(client.calls.length, 0);
});

test("batch label maps to the canonical twin's category", async () => {
  const client = fakeClient([{ category: "地方性法规" }]);
  assert.equal(
    await resolveBatchCategory(client, { title: "某条例", category: "重下载" }),
    "地方性法规",
  );
  assert.equal(client.calls.length, 1);
});

test("batch label survives when no canonical twin exists", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "重下载" }), "重下载");
});

test("non-batch categories pass through without a query", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "行政法规" }), "行政法规");
  assert.equal(client.calls.length, 0);
});

test("synonym spelling is normalized even outside the batch path", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "地方法规" }), "地方性法规");
  assert.equal(client.calls.length, 0);
});

test("batch mapping prefers an effective twin when ordering matters", async () => {
  const client = fakeClient([{ category: "法律" }]);
  await resolveBatchCategory(client, { title: "某法", category: "新法速递" });
  assert.match(client.calls[0].sql, /CASE WHEN status = '有效' THEN 0 ELSE 1 END/);
});

// --- 同名不同文号不是同一个（审计 06 §7）---------------------------------------
//
// `findCrossGenerationDuplicate` 原来**只按 title 判重**：同名同类别同有效，
// 就当成重复跳过 INSERT。但「113 号」与「71 号」都叫《行政单位财务规则》，
// 是两个不同版本（fd-text-core 的 `split_doc_number` docstring 记的正是这个
// 真实事故：113 号的施行日被挂到了 71 号上）。只按标题判重，第二个版本永远进不了库，
// 唯一痕迹是一行聚合计数（`skippedDuplicate++`），没有标题也没有 source_id。

test("extractDocNumber 认出「（财政部令第113号）」这类括号文号", () => {
  assert.equal(
    extractDocNumber("行政单位财务规则（财政部令第113号）"),
    "财政部令第113号",
  );
});

test("extractDocNumber 对没有文号的标题返回 null", () => {
  assert.equal(extractDocNumber("中华人民共和国网络安全法"), null);
});

test("同名不同文号不算重复——库里已有 71 号，来的是 113 号", async () => {
  // **关键：fake 必须真的返回一条同名行**。第一版我返回空数组，
  // 于是走的是「没找到」分支、根本没进文号比对——反向实验时发现
  // 「改回只按标题判重」测试照样全绿，那是个假测试。
  const client = fakeClient([
    { title: "行政单位财务规则（财政部令第71号）", doc_number: "财政部令第71号" },
  ]);
  const dup = await findCrossGenerationDuplicate(client, {
    title: "行政单位财务规则（财政部令第113号）",
  });
  assert.equal(
    dup,
    false,
    "同名但文号不同（71 vs 113）被判成重复 —— 第二个版本永远进不了库",
  );
});

test("同名同文号才算重复", async () => {
  const client = fakeClient([
    { title: "行政单位财务规则（财政部令第113号）", doc_number: "财政部令第113号" },
  ]);
  assert.equal(
    await findCrossGenerationDuplicate(client, {
      title: "行政单位财务规则（财政部令第113号）",
    }),
    true,
  );
});

test("已有行没有文号列时，从标题里回退提取", async () => {
  const client = fakeClient([
    { title: "行政单位财务规则（财政部令第113号）" }, // 无 doc_number 字段
  ]);
  assert.equal(
    await findCrossGenerationDuplicate(client, {
      title: "行政单位财务规则（财政部令第113号）",
    }),
    true,
    "没有 doc_number 列时应当回退到从标题提取，否则同一条会被重复插入",
  );
});
