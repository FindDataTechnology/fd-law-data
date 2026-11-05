// Platform-aware state directory for the wenshu nightly supervisor
// (lib/wenshu/nightly-paths.js). The Mac keeps its /tmp legacy; the Windows
// host keeps state under the user profile; the env var overrides both.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stateDirFor, WENSHU_LIVENESS_KEY } from "../lib/wenshu/nightly-paths.js";

describe("wenshu nightly state dir", () => {
  it("macOS legacy stays /tmp", () => {
    assert.equal(stateDirFor("darwin", {}), "/tmp");
  });

  it("windows host uses %USERPROFILE%\\wenshu-nightly", () => {
    const dir = stateDirFor("win32", { USERPROFILE: "C:\\Users\\admin" });
    assert.ok(dir.startsWith("C:\\Users\\admin"));
    assert.ok(dir.endsWith("wenshu-nightly"));
  });

  it("WENSHU_NIGHTLY_DIR overrides both platforms", () => {
    assert.equal(stateDirFor("darwin", { WENSHU_NIGHTLY_DIR: "/data/wenshu" }), "/data/wenshu");
    assert.equal(stateDirFor("win32", { WENSHU_NIGHTLY_DIR: "D:\\wenshu" }), "D:\\wenshu");
  });

  it("liveness key is stable (nightly writes it, report reads it)", () => {
    assert.equal(WENSHU_LIVENESS_KEY, "nightly/liveness.json");
  });
});
