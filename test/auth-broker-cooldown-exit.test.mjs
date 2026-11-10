import test from "node:test";
import assert from "node:assert/strict";
import { acquireIdentityLease, cooldownExpired, COOLDOWN_MINUTES } from "/Users/chengsishi/finddata/fd-law-data/lib/auth-broker/identity.js";

function fakeClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
      if (/UPDATE legal_source_identity/i.test(sql) && /status='active'/i.test(sql)) {
        return { rows: [{ ...rows[0], status: "active", updated_at: new Date() }] };
      }
      if (/UPDATE legal_source_identity/i.test(sql)) {
        return { rows: [{ ...rows[0], status: "active", lease_token: "tok" }] };
      }
      return { rows };
    },
  };
}

const base = {
  id: "1", source: "s", account_id: "a", status: "cooldown",
  lease_owner: null, lease_token: null, lease_expires_at: null,
  failure_count: 7, last_success_at: null,
};

test("cooldown 未到期时仍然拒绝租借", async () => {
  const c = fakeClient([{ ...base, updated_at: new Date(Date.now() - 60_000) }]);
  await assert.rejects(() => acquireIdentityLease(c, { source: "s", accountId: "a", owner: "o" }),
    (e) => e.code === "IDENTITY_NOT_ELIGIBLE" && e.status === "cooldown");
});

test("cooldown 到期后被放回 active 并留痕（这条边以前是缺的）", async () => {
  const old = new Date(Date.now() - (COOLDOWN_MINUTES + 1) * 60_000);
  const c = fakeClient([{ ...base, updated_at: old }]);
  const out = await acquireIdentityLease(c, { source: "s", accountId: "a", owner: "o" });
  assert.equal(out.identity.status, "active");
  const revive = c.calls.find((x) => /SET status='active'/i.test(x.sql));
  assert.ok(revive, "必须真的执行了状态改写");
  const evt = c.calls.find((x) => /legal_source_identity_event/i.test(x.sql) && /identity_updated/.test(x.sql));
  assert.ok(evt, "必须留审计事件");
  // 参数形状：[identity_id, actor, reason, metadata]（event_kind 是 SQL 字面量）
  assert.match(String(evt.params[2]), /cooldown expired/);
  assert.match(String(evt.params[3]), /"to":"active"/);
});

test("login_required 不会被冷却出口救活（那是一定要人工的）", async () => {
  const old = new Date(Date.now() - 999 * 60_000);
  const c = fakeClient([{ ...base, status: "login_required", updated_at: old }]);
  await assert.rejects(() => acquireIdentityLease(c, { source: "s", accountId: "a", owner: "o" }),
    (e) => e.code === "IDENTITY_NOT_ELIGIBLE" && e.status === "login_required");
});

test("cooldownExpired 只对 cooldown 生效，且容忍缺 updated_at", () => {
  assert.equal(cooldownExpired({ status: "cooldown", updated_at: new Date(Date.now() - 3_600_000) }), true);
  assert.equal(cooldownExpired({ status: "cooldown", updated_at: new Date() }), false);
  assert.equal(cooldownExpired({ status: "active", updated_at: new Date(Date.now() - 3_600_000) }), false);
  assert.equal(cooldownExpired({ status: "cooldown", updated_at: null }), false);
});
