# 文档目录（INDEX）

仓库里所有文档的入口，每行一句话说明用途。第一次接触这个仓库时，按「先读」→「部署」的顺序看就够了。

## 先读

- [README.md](../README.md)：仓库是什么、6 个插件各做什么、必须配置什么，「从零开始」的完整步骤和架构图
- [CLONE.md](../CLONE.md)：在 Windows / WSL 上 clone 私有仓库（Gitea 8444 端口，需要 mTLS 证书）
- [MANIFEST.md](../MANIFEST.md)：目录表与文件数，各插件的入口、构建方式，以及换机时要改的路径
- 各插件说明（装好后在哪里看到、要配置什么、怎么用）：
  - [plugins/dsh-router-b/README.md](../plugins/dsh-router-b/README.md)：分区路由与作战室界面
  - [plugins/dsh-token-stats/README.md](../plugins/dsh-token-stats/README.md)：Token 用量统计
  - [plugins/dsh-egress/README.md](../plugins/dsh-egress/README.md)：模型出口代理
  - [plugins/dsh-vpn/README.md](../plugins/dsh-vpn/README.md)：VPN 管理
  - [plugins/dsh-secrets/README.md](../plugins/dsh-secrets/README.md)：加密密钥库与密钥看板
  - [plugins/dsh-agent-hub/README.md](../plugins/dsh-agent-hub/README.md)：DSH 作为 dsh-hub 控制方、Agent 调度页、worker 接入
  - [plugins/dsh-fileshare/README.md](../plugins/dsh-fileshare/README.md)：文件中转，临时下载 / 上传链接（代替 scp）

## 部署

- [README-MIGRATE.md](README-MIGRATE.md)：在新服务器上装 DSH 和插件的完整手册（系统依赖、profile、软链、dump-config、systemd、nginx）
- [services/dsh-hub/README.md](../services/dsh-hub/README.md)：部署独立的 dsh-hub 服务（hub.json、TLS、IP 白名单、签发令牌、systemd）
- [services/dsh-hub/deploy/docker/README.md](../services/dsh-hub/deploy/docker/README.md)：在本机用 Docker 跑通 hub + 本地 DSH + worker 整条链路
- [DEPLOY-HUB-PROMPT.md](DEPLOY-HUB-PROMPT.md)：交给服务器上云端 DSH 的部署提示词，分两轮执行，以重启 dsh-web 为界
- [nginx/README.md](nginx/README.md)：4 个 nginx 站点的脱敏模板及占位符说明（8443 DSH Web、8444 Gitea mTLS 等）
- [CLONE-ON-WORKSTATION.md](CLONE-ON-WORKSTATION.md)：旧版 clone 说明（bash），以根目录的 CLONE.md 为准
- [plugins/dsh-secrets/docs/USAGE.md](../plugins/dsh-secrets/docs/USAGE.md)：密钥库的口令、工具、导出导入和故障排查
- [plugins/dsh-secrets/docs/READINESS.md](../plugins/dsh-secrets/docs/READINESS.md)：密钥库上线前检查单
- [plugins/dsh-router-b/docs/UPGRADE.md](../plugins/dsh-router-b/docs/UPGRADE.md)：DSH 升级后如何重装和重建 router
- [plugins/dsh-egress/docs/MIHOMO.md](../plugins/dsh-egress/docs/MIHOMO.md)：egress 配合 mihomo / Clash 使用

## 协议与设计

- [DSH-HUB-PROTOCOL-v2.md](DSH-HUB-PROTOCOL-v2.md)：dsh-hub 协议 `dsh-agent/2.0`，包括角色、令牌、接口、工作区路由、网络与代理、worker 状态机
- [UI-STYLE.md](UI-STYLE.md)：所有 client-ui 插件统一遵守的 UI 规范（DeepSeek 原生风格）
- [plugins/dsh-secrets/DESIGN.md](../plugins/dsh-secrets/DESIGN.md)：密钥库的威胁模型、文件格式，以及为什么不提供 `secret_get`
- [plugins/dsh-secrets/docs/DASHBOARD.md](../plugins/dsh-secrets/docs/DASHBOARD.md)：只读密钥看板的接口与字段白名单
- [plugins/dsh-router-b/docs/ARCHITECTURE.md](../plugins/dsh-router-b/docs/ARCHITECTURE.md)：router 的架构
- [plugins/dsh-router-b/docs/INTEGRATION.md](../plugins/dsh-router-b/docs/INTEGRATION.md)：router 与 DSH 的集成点
- [plugins/dsh-router-b/docs/API-0.2.2-rc.3.md](../plugins/dsh-router-b/docs/API-0.2.2-rc.3.md)：router 依赖的 DSH API 记录
- [plugins/dsh-router-b/docs/REQUIREMENTS-v2.md](../plugins/dsh-router-b/docs/REQUIREMENTS-v2.md)、[ROADMAP.md](../plugins/dsh-router-b/docs/ROADMAP.md)、[HANDOFF.md](../plugins/dsh-router-b/docs/HANDOFF.md)：router 的需求、路线图和交接记录
- [plugins/dsh-router-b/packages/client-ui-router/docs/CONTRACT.md](../plugins/dsh-router-b/packages/client-ui-router/docs/CONTRACT.md)、[NATIVE-ENTRYPOINTS.md](../plugins/dsh-router-b/packages/client-ui-router/docs/NATIVE-ENTRYPOINTS.md)：router client 的接口契约和挂载入口
- [plugins/dsh-router-b/packages/host-router/docs/HOST-CONTRACT.md](../plugins/dsh-router-b/packages/host-router/docs/HOST-CONTRACT.md)：router host 的接口契约
- [plugins/dsh-egress/docs/EGRESS.md](../plugins/dsh-egress/docs/EGRESS.md)、[RESEARCH.md](../plugins/dsh-egress/docs/RESEARCH.md)：egress 的设计和调研
- [plugins/dsh-vpn/docs/VPN.md](../plugins/dsh-vpn/docs/VPN.md)：VPN 插件的说明与配置
- 插件管理里「详细说明」链接指向的文件：`plugins/dsh-router-b/docs/DETAIL.zh.md`、`plugins/dsh-egress/docs/DETAIL.zh.md`（另有英文版 `DETAIL.md`）

## 迁移审计历史（只作背景，内容以上面的文档为准）

以下是 2026-11-20 对服务器做只读审计留下的报告，那时还只有 4～5 个插件，也还没有 agent-hub / dsh-hub。

- [W1-runtime-config.md](W1-runtime-config.md)：DSH 运行时配置与 router 状态数据
- [W2-system-deps.md](W2-system-deps.md)：系统侧依赖与网络入口（systemd、nginx、端口）
- [W3-env-plugins.md](W3-env-plugins.md)：环境依赖与插件加载机制
- [W4-repo-nonpkg.md](W4-repo-nonpkg.md)：插件仓库里不属于插件包的内容
- [W5-datasource-paths.md](W5-datasource-paths.md)：Token 统计数据源，以及硬编码的绝对路径清单
- [W6-MIGRATION-MANUAL.md](W6-MIGRATION-MANUAL.md)：由 W1–W5 合成的移植手册
- [MANIFEST.md](MANIFEST.md)：2026-11-21 生成的发布内容、来源和路径映射清单（docs 版，与根目录的 MANIFEST.md 不同）
