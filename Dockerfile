# fd-law-data crawler image (flk incremental crawl; no PG client-side need
# beyond the loader which runs on the data machine, not in this image).
# curl is required by lib/auth-broker/proxy-fetch.js: identity-bound egress
# (rmfyalk platform session) shells out to curl for its TLS fingerprint;
# without it every proxied request fails with "spawn curl ENOENT" and the
# crawl silently reports listed=0 (page-level failure, not fatal).
FROM docker.m.daocloud.io/library/node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# USTC's apt mirror over plain http: the daocloud slim base ships no system
# CA store (https mirrors fail handshake), and Tencent's own mirror 302s to
# https. apt package integrity is GPG-verified regardless of transport.
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

COPY lib/ lib/
COPY bin/ bin/

# 镜像自报 tag —— crawl_runs.image_tag 的可靠来源。
#
# 2026-11-14 实历两遍同型漂移：`FD_RUNNER_IMAGE_TAG` 是手写的、与 `image:` 只隔
# 一行，每次发版记得改 image 却忘了改它 ⇒ 行里写 sha-b63d0d1、真跑的是
# sha-30f5179；当天我正是靠这一列判「修复在不在镜像里」，一列假读数会把诊断带偏。
# 所以把 tag 烘进镜像：镜像说自己是哪一片，env 只剩兜底作用。
#
# IMAGE_TAG 由 image.yml 传入（`sha-<7>`，与它铸的不可变 tag 同一个表达式），
# 不传则 `dev`——本地构建不会冒充某个正式片。
ARG IMAGE_TAG=dev
RUN printf '%s\n' "$IMAGE_TAG" > /app/IMAGE_TAG

RUN useradd -m crawler && chown -R crawler /app
USER crawler

CMD ["node", "bin/flk-crawl.mjs"]
