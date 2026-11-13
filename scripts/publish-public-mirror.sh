#!/usr/bin/env bash
# Publish the private fd-law-data tree to the PUBLIC build mirror.
#
# The public repo exists so GitHub Actions runs on the free unlimited public
# allowance instead of the metered private one. That only works if the public
# tree carries build inputs and nothing that describes our infrastructure:
# k8s manifests, mesh addresses, cluster/host names, and any hardcoded internal
# default all stay behind.
#
# Usage:  ./scripts/publish-public-mirror.sh [--dry-run]
# Then:   cd /tmp/fd-law-data-mirror && git add -A && git commit && git push
#
# Re-runnable: it always rsyncs the current source, then re-applies the
# sanitisation, so a later private commit cannot silently leak a mesh address.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="${MIRROR:-/tmp/fd-law-data-mirror}"
DRY_RUN="${1:-}"

if [ ! -d "$MIRROR/.git" ]; then
  echo "error: $MIRROR is not a git checkout (clone git@github.com:scs001/fd-law-data.git first)" >&2
  exit 1
fi

echo "== sync $SRC -> $MIRROR"
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.DS_Store' \
  --exclude='k8s' --exclude='docs/incidents' \
  --exclude='.env' --exclude='.env.*' --exclude='*creds*.txt' \
  --exclude='kubeconfig*' --exclude='.harbor-*' \
  --exclude='graphify-out' --exclude='.work-*' \
  "$SRC/" "$MIRROR/"

cd "$MIRROR"

python3 - <<'PY'
import re
from pathlib import Path

def patch(path, old, new):
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"missing file: {path}")
    s = p.read_text(encoding="utf-8")
    if old not in s:
        return  # already sanitised (script is re-runnable)
    p.write_text(s.replace(old, new, 1), encoding="utf-8")

# README and the workflow header are the only files that legitimately differ
# between the private tree (which documents this deployment) and the public
# build mirror. Code-level defaults are fixed in the source repo itself so the
# two trees cannot drift.

patch("README.md",
      """**xinru cluster, `scraw` namespace** (where the proxy/scraw infra actually
runs — NOT the migrating cheap cluster):

```bash
# one-time secrets (already created 2026-09-18):
#   harbor-lawcraw-pull            — dockerconfigjson for 100.64.0.8:30880/lawcraw_business
#   flk-law-crawl-credentials      — rustfs-access-key / rustfs-secret-key
kubectl -n scraw apply -f k8s/flk-crawl-cronjob.yaml   # daily 02:30 Asia/Shanghai
```""",
      """**Kubernetes CronJob** (daily 02:30 Asia/Shanghai). The deployment manifests
are not part of this repository — they carry cluster-specific addressing. Apply
them from your own infrastructure repo, providing a `dockerconfigjson` pull
secret for your registry, a Secret with `rustfs-access-key` /
`rustfs-secret-key`, and `RUSTFS_ENDPOINT` / `LAWS_BUCKET` as container env.

```bash
kubectl apply -f <your-infra-repo>/flk-crawl-cronjob.yaml
```""")

patch("README.md",
      """Image: **built by the Jenkins job `fd-law-data`** — gitee push (webhook token
`fd-law-data`) → `docker build` → push to `100.64.0.8:30880/lawcraw_business/`,
tagged with the immutable `sha-<short-hash>` of the commit it was built from
(push a branch and read the tag off the build log, then pin it in the
manifest).""",
      """Image: **built by GitHub Actions** (`.github/workflows/image.yml`) — every push
to `main` runs the test suite, then builds and pushes all three images tagged
with the immutable `sha-<short-hash>` of the triggering commit (plus a rolling
`main`). Pin the `sha-` tag in your deployment manifest.""")

patch("README.md",
      """**xinru cluster, `scraw` namespace**: helm chart `wenshuCrawl` block, or the
standalone `k8s/wenshu-crawl-cronjob.yaml`. Image:
`lawcraw_business/fd-law-data-wenshu` — Playwright image built from
`fd-law-data/Dockerfile.wenshu`.""",
      """A Kubernetes CronJob (manifests live in your infrastructure repo, not here).
Image: `fd-law-data-wenshu` — the Playwright image built from
`Dockerfile.wenshu`.""")

p = Path("README.md")
s = p.read_text(encoding="utf-8")
start = s.find("### Image channel: GitHub Actions")
if start != -1:
    end = s.find("### Daily report inspection")
    if end == -1:
        raise SystemExit("anchor '### Daily report inspection' not found")
    s = s[:start] + """### Image channel

Every push to `main` runs the test suite and then builds + pushes all three
images to the registry configured in `.github/workflows/image.yml`, tagged with
the immutable `sha-<7-char>` of the triggering commit plus a rolling `main`.

Warm the node before a dry-run or a roll and confirm the digest with
`crictl pull <registry>/<ns>/fd-law-data:sha-<x>`.

**Tag eviction.** Many registries (including Tencent TCR personal edition) cap
tags per repository and do **not** reclaim the quota when a tag is deleted
through the v2 API — only the console does. A deployment that pins a tag the
registry has evicted dies with `manifest unknown` the moment the node's image
cache is GC'd.

Rules that follow:

1. **Audit your pins.** Every tag a live object pins must still resolve.
2. **Only pin tags that exist in the registry your nodes pull from.** Verify
   both sides with `skopeo inspect` before a roll.
3. Keep the last known-good `sha-` tag per image so a rollback is a manifest
   edit rather than a rebuild.

**If Actions is blocked by account billing**: private repositories draw on a
metered Actions allowance, public ones do not. Either make the build repository
public (this repo carries no credentials — secrets arrive via Actions secrets
and cluster Secrets), or do a delta build from the previous image.

""" + s[end:]
    p.write_text(s, encoding="utf-8")

patch(".github/workflows/image.yml",
      """#   legal-auth-broker   ← Dockerfile.auth-broker（Harbor 侧镜像名：k8s 清单引
#                          lawcraw_business/legal-auth-broker、cheap-3 tcr-relay
#                          repos.conf 亦按此名登记；原 GHA 用的
#                          fd-law-data-auth-broker 从未进 relay=ccr 侧无引用，
#                          2026-10-09 改名对齐，避免双名分叉）""",
      """#   legal-auth-broker   ← Dockerfile.auth-broker（部署清单按此名引用；原名
#                          fd-law-data-auth-broker 无消费方，2026-10-09 改名对齐）""")

# ── 触发器必须还原：这一处镜像仓与私源**本来就该不同** ──────────────────────
#
# 私源 2026-11-09 为省私有额度把 `push:` 删了，只留 workflow_dispatch（注释写得很
# 清楚：本仓 CI 因组织私有额度耗尽而全部瞬时失败）。那处改动会跟着 rsync 一起进入
# 本仓，而本仓恰恰**靠 push 触发免费构建**。2026-11-14 实历：不还原的话
# `git push` 成功、Actions 一条 run 都不起、零提示——出片通道静默关闭。
#
# 所以这里显式保证 push: 存在；下面的自检再确认一次（自检失败就不许提交）。
workflow = Path(".github/workflows/image.yml")
wf = workflow.read_text(encoding="utf-8")
# 必须锚定行首：`push: true`（build-push-action 的入参）也含 "  push:" 子串，
# 用 `in` 判断会把「没有触发器」误判成「已经有了」——第一版就是这么错的，
# 由下面的自检抓出来。
if not re.search(r"^  push:", wf, re.M):
    if wf.count("on:\n  workflow_dispatch:") == 1:
        wf = wf.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:")
        workflow.write_text(wf, encoding="utf-8")
        print("restored push trigger")
    else:
        raise SystemExit("image.yml 的 on: 段形状变了，无法自动还原 push 触发器——请人工核对")
print("sanitised")
PY

echo "== scan for leftovers (registry host in the workflow is expected)"
if grep -rnE '100\.64\.|192\.168\.|cheap3|cheap-3|xinru|tcr-relay|/etc/tcr-relay' \
     --exclude-dir=.git --exclude-dir=node_modules \
     --exclude='publish-public-mirror.sh' . 2>/dev/null | head -10; then
  echo "!! leftovers above — fix before committing" >&2
  exit 1
fi
echo "clean"

# ── 自检：推之前就红，别指望推完再看 ────────────────────────────────────────
echo "== self-check"
if ! grep -q '^  push:' .github/workflows/image.yml; then
  echo "!! image.yml 没有 push 触发器：推上去不会起构建（出片静默关闭）" >&2
  exit 1
fi
if [ -d graphify-out ]; then
  echo "!! graphify-out/ 被带进公开仓——本地产物不该进公开历史" >&2
  exit 1
fi
# 未跟踪目录会跟着提交进公开仓。只对**含文件**的目录报错：git 不收录空目录，
# 空目录泄不出去，报了只会让这条闸常年红（最终被人无视）。
untracked_dirs=$(git ls-files --others --exclude-standard --directory \
  | grep '/$' | while IFS= read -r d; do
      [ -n "$(find "$d" -type f -print -quit 2>/dev/null)" ] && echo "$d"
    done || true)
if [ -n "$untracked_dirs" ]; then
  echo "!! 未跟踪目录里有文件，会一起进公开仓，先清理：" >&2
  echo "$untracked_dirs" >&2
  exit 1
fi
echo "ok"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "== dry run: not committing"
  git --no-pager diff --stat
  exit 0
fi

echo "== done; review 'git status' then commit and push"
