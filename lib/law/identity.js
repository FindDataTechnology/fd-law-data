// Loader-side identity rules for law-db-hygiene (design D6): the flk loader
// must not re-insert a law that already exists under another corpus
// generation, and must not store crawler-batch labels as categories when a
// canonical twin exists. Pure of I/O except the passed-in pg client.
import { BATCH_CATEGORIES, normalizeCategory } from "./reconcile.js";

const BATCH_LIST = [...BATCH_CATEGORIES];

/** 全角括号包裹的文号，如「（财政部令第113号）」。 */
const DOC_NUM_WRAPPED = /[（(]([^（）()]*?令?第\s*[0-9〇零一二三四五六七八九十百]+\s*号)[）)]/;

/**
 * 从标题里抽出文号；没有则返回 null（审计 06 §7）。
 *
 * **为什么文号必须参与身份**：`fd-text-core/fd_text_core/kg_lane/merge.py` 的
 * `split_doc_number` docstring 记着一次真实事故——「113 号」与「71 号」都叫
 * 《行政单位财务规则》，是两个不同版本，各有自己的有效期；抽取把 113 号的施行日
 * 挂到了 71 号上，根因就是同名实体被当成同一个。
 *
 * 这里只做**存在性**判定，不解析机关令前缀的语义：只要能取出文号串，就足以
 * 区分「同名但不同版本」。
 *
 * 拆完主体为空则不拆（宁可留一个不完美的标题，也不造空标题造成假归并）。
 */
export function extractDocNumber(title) {
  if (!title) return null;
  const m = String(title).match(DOC_NUM_WRAPPED);
  if (!m) return null;
  const num = m[1].replace(/\s+/g, "");
  const bare = String(title).replace(m[0], "").trim();
  return bare ? num : null;
}

/**
 * True when the same law already exists in any generation with a real-law
 * category and `有效` status — the caller skips the INSERT.
 * NULL categories count as non-batch (never as a batch label).
 *
 * **文号参与身份**（审计 06 §7）：原实现只比 title，同名不同文号的第二个版本
 * 会被当成重复丢掉，而唯一痕迹是一行不带标题/来源的聚合计数。现在：
 *   * 传入标题**带文号** → 取出所有同名的有效行，逐条比对文号；
 *     只有文号也相同才算重复（对方无文号也算「不同」——那是另一个版本）；
 *   * 传入标题**无文号** → 维持原行为（按标题判重），避免把「同名的无文号标题」
 *     与「带文号的版本」混为一谈而误跳过。
 */
export async function findCrossGenerationDuplicate(client, { title }) {
  if (!title) return false;
  const incomingDocNo = extractDocNumber(title);
  // 用 `to_jsonb(laws) ->> 'doc_number'` 而不是裸投影 `SELECT doc_number`：
  // 生产 `law_db.laws` 只有 16 列、**没有** doc_number（2026-11-14 实测），
  // 裸投影会在第一条记录上抛 42703「字段 "doc_number" 不存在」，整个 loader
  // 直接崩掉。行转 jsonb 对「有列 / 无列」两种库都成立：缺列时得 NULL，
  // 下面回退到从标题提取。原来的测试只覆盖了「行里没有这个字段」，
  // 覆盖不到「表里没有这一列」——那正是这次漏网的地方。
  const { rows } = await client.query(
    `SELECT title, to_jsonb(laws) ->> 'doc_number' AS doc_number
       FROM laws
      WHERE lower(title) = lower($1)
        AND status = '有效'
        AND (category IS NULL OR NOT (category = ANY($2)))`,
    [title, BATCH_LIST],
  );
  if (rows.length === 0) return false;
  if (!incomingDocNo) return true; // 无文号：维持旧的按标题判重
  // 有文号：只在与某条已有行的文号相同（且双方都有文号）时才算重复。
  return rows.some((r) => {
    const existing = r.doc_number ?? extractDocNumber(r.title);
    return existing != null && existing === incomingDocNo;
  });
}

/**
 * Map a crawler-batch label to the same title's canonical category when one
 * exists (legacy manual re-download imports); otherwise return the label
 * unchanged. Non-batch categories pass through untouched.
 */
export async function resolveBatchCategory(client, { title, category }) {
  const normalized = normalizeCategory(category);
  if (!BATCH_CATEGORIES.has(normalized) || !title) return normalized;
  const { rows } = await client.query(
    `SELECT category FROM laws
      WHERE lower(title) = lower($1)
        AND (category IS NULL OR NOT (category = ANY($2)))
      ORDER BY CASE WHEN status = '有效' THEN 0 ELSE 1 END
      LIMIT 1`,
    [title, BATCH_LIST],
  );
  return rows.length ? normalizeCategory(rows[0].category) : normalized;
}
