// Platform-aware bits shared by the wenshu nightly supervisor (scripts/) and
// the daily legal-sources report (lib/legal-sources/report.js).
//
// State directory: the Mac legacy stays /tmp (unchanged for manual runs);
// the promised host windows-admin (Windows) keeps state under the user
// profile so it survives reboots and is not a system temp dir. WENSHU_NIGHTLY_DIR
// overrides both. Windows paths are joined textually (no host-specific
// resolve) so the shape is deterministic on any platform.
import { resolve } from "node:path";

export const WENSHU_LIVENESS_KEY = "nightly/liveness.json";

export function stateDirFor(platform = process.platform, env = process.env) {
  if (env.WENSHU_NIGHTLY_DIR) return env.WENSHU_NIGHTLY_DIR;
  if (platform === "win32") {
    const base = (env.USERPROFILE ?? "").replace(/[\\/]+$/, "");
    return base ? `${base}\\wenshu-nightly` : "wenshu-nightly";
  }
  return "/tmp";
}
