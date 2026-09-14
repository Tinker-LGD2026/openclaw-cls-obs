# Changelog

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
