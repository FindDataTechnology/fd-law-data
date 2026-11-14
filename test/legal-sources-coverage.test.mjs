import test from "node:test";
import assert from "node:assert/strict";
import { summarizeManifests } from "../lib/legal-sources/coverage.js";

test("coverage sums immutable manifests and exposes the latest gap state", () => {
  const summary = summarizeManifests([
    {
      runDate: "2026-09-22", runId: "1", mode: "full", finishedAt: "2026-09-22T00:00:00Z",
      coverage: { sourceTotal: 5000, listed: 5000, planned: 5000, emitted: 4980, failures: 20, missingText: 3, attachments: 12, complete: false, unreachablePages: [{ page: 9 }] },
    },
    {
      runDate: "2026-09-23", runId: "2", mode: "incremental", finishedAt: "2026-09-23T00:00:00Z",
      coverage: { sourceTotal: 5010, listed: 5010, planned: 10, emitted: 10, failures: 0, missingText: 0, attachments: 0, complete: true, unreachablePages: [] },
    },
  ]);
  assert.equal(summary.runs, 2);
  assert.equal(summary.cumulative.emitted, 4990);
  assert.equal(summary.cumulative.failures, 20);
  assert.equal(summary.latest.complete, true);
  assert.equal(summary.latest.planned, 10);
  assert.equal(summary.latest.sourceTotal, 5010);
});

test("empty manifest history is explicitly missing rather than complete", () => {
  const summary = summarizeManifests([]);
  assert.equal(summary.latest, null);
  assert.equal(summary.cumulative.runs, 0);
});

// 超尺寸附件被跳过时，正文照常入库、附件永久缺失。这个数字必须出现在**报告**里
// （latest + 累计），否则字段只躺在某一轮 manifest 中，没人读＝等于没加。
// 2026-11-14：mfa-treaty 一轮 skippedAttachments=8，而报告里看不到它。
test("skippedAttachments 进报告：latest 与累计都带出来", () => {
  const manifests = [
    { finishedAt: "2026-11-13T19:00:00Z", coverage: { emitted: 40, skippedAttachments: 3 } },
    { finishedAt: "2026-11-14T19:00:00Z", coverage: { emitted: 5, skippedAttachments: 5, attachments: 0 } },
  ];
  const summary = summarizeManifests(manifests);
  assert.equal(summary.latest.skippedAttachments, 5, "latest 反映最近一轮");
  assert.equal(summary.cumulative.skippedAttachments, 8, "累计反映整段时间");
});

test("没有该字段的老清单不让累计变成 NaN", () => {
  const summary = summarizeManifests([
    { finishedAt: "2026-11-14T19:00:00Z", coverage: { emitted: 1 } },
  ]);
  assert.equal(summary.cumulative.skippedAttachments, 0);
  assert.equal(summary.latest.skippedAttachments, null);
});
