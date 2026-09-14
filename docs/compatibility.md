# 宿主版本兼容矩阵

## 支持矩阵

| OpenClaw 版本 | 状态 | 验证 |
|---|---|---|
| 2026.6.5 | ✅ 支持 | 全部测试与 E2E 常驻 |
| 2026.7.1-2 | ✅ 支持 | `scripts/compat-matrix.sh` 发版门禁 |

## 门禁

发版前必须双版本通过(发布流水线自动执行,宿主从 npm 拉取,不 vendored 进 git):

```bash
sh scripts/compat-matrix.sh
```

## Hook 依赖与降级

插件注册全部 Hook 时做了版本弹性:宿主不认识某 Hook 名时注册降级、启动日志
告警(`hooks unavailable on this host: ...`),相关能力静默缺席而非报错。

| 能力 | 依赖 Hook | 缺失时的行为 |
|---|---|---|
| 逐调用 token/成本 | `before_message_write` | chat 不带 usage;agent 仍有轮级聚合 |
| subagent 嵌套 | `subagent_spawned` / `subagent_ended` | 子 run 退化为独立 trace |
| 轮次/内容 | `llm_input` / `llm_output` / `model_call_*` | 核心链路,2026.6.5 起均有 |
