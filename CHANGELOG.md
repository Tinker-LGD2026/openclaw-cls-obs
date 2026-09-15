# Changelog

## [0.2.0] - 2026-09-15

### Added
- 配置文件支持:`plugins.entries.cls-agent-observability.config` 全字段
  (env 优先、文件兜底),修改热更新无需重启;启动打印脱敏生效摘要。
- 插件自观测:`CLS_STATS_INTERVAL_MS`(默认 5 分钟)周期 stats 日志。
- 文档:运维手册(重启语义)、数据分级说明、英文 README、NOTICE。

### Performance
- 会话指纹改为记忆化 per-message 哈希链:长会话每模型调用的指纹开销
  16ms → 0.2ms(80~200×),500 轮会话 CPU 15.2s → 0.1s。

### Fixed
- 显式 `CLS_CONTENT_MODE=off` 不再误报"无法识别的值"。

## [0.1.1] - 2026-09-14

### Fixed
- install.sh 写入 `hooks.allowConversationAccess=true`(缺授权时插件加载但零产出)。
- 容器部署示例补齐启用配置落盘,镜像构建后 gateway 拉起即启用。

### Changed
- README 重写为客户视角;npm 发布切换到 OIDC Trusted Publishing(无长期 token)。

## [0.1.0] - 2026-09-14

### Added
- 首个公开分发形态:零依赖 bundle(`dist-bundle/index.mjs`),COS + npm 双通道。
- 安装/卸载脚本(sha256 校验、`plugins.allow` 白名单结构化合并、升级安全解包)。
- 双宿主版本兼容门禁:`scripts/compat-matrix.sh`(2026.6.5 与 2026.7.1-2)。
- CI:push 跑测试与打包;tag 触发双版本门禁 → npm publish → COS 上传。
- 部署文档:容器/TKE initContainer/systemd/离线四种集成形态。
