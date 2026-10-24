# syntax=docker/dockerfile:1
# 多阶段构建：所有编译都在 CI runner 完成，服务器只 pull 镜像（§9-坑4）
FROM node:20-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# better-sqlite3 优先用预编译包；无预编译时回退 node-gyp 需要编译链
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/client apps/client

RUN pnpm --filter @autonotice/shared build \
    && pnpm --filter @autonotice/server build \
    && pnpm --filter @autonotice/client build

FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

# 管理员 Shell 需要 docker / docker compose 才能在容器内做整套服务运维。
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# 保留 pnpm 的 /repo 目录布局，node_modules 内的相对符号链接才能正确解析
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/server ./apps/server
COPY --from=build /repo/apps/client/dist ./apps/client/dist
# 机器人自迭代时可直接读取工程文档
COPY AI-WORKFLOW.md ./AI-WORKFLOW.md

# 持久化工具：AI 可安装命令行工具，容器重启后由 entrypoint 自动恢复
COPY deploy/entrypoint.sh ./entrypoint.sh
COPY deploy/install-tool.sh /usr/local/bin/autonotice-install-tool
RUN chmod +x ./entrypoint.sh /usr/local/bin/autonotice-install-tool

ENV PATH=/app/data/tools/bin:$PATH

WORKDIR /repo/apps/server
EXPOSE 8080
ENTRYPOINT ["/repo/entrypoint.sh"]
CMD ["node", "dist/index.js"]
