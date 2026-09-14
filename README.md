# OpenClaw CLS Agent Observability

OpenClaw 插件：把 Agent 执行过程导出为腾讯云 CLS Agent Trace。安装即用，不改
OpenClaw 任何配置与代码——调用链、Token 用量、工具调用、错误自动出现在 CLS
控制台的 Agent 可观测视图里。

## 它能给你什么

| 能力 | 说明 |
|---|---|
| 调用链 | 一次提问的完整树:Turn → ReAct 轮 → 模型调用 → 工具执行 |
| Token 用量 | **逐次模型调用**精确归属(input/output/缓存分列),轮级自动聚合 |
| 成本估算 | 按模型价格表估算每次调用成本(非账单) |
| 工具详情 | 工具名、参数、结果、耗时、退出码 |
| 错误分类 | 工具非零退出、模型断流等低基数 `error.type`,父级恢复状态正确传递 |
| Subagent | 父子 Trace 嵌套关联,`sessions_spawn` 派生的子任务不丢失 |
| 正文采集 | 默认关闭;开启后按轮/按调用上报消息,长会话自动增量去重 |

上报走标准 OTLP/HTTP,直传 CLS Trace Topic。

## 快速开始(5 分钟)

**1. 安装插件**

```bash
# COS(推荐,公网/腾讯内网均可达)
curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/install.sh | sh

# 或 npm
openclaw plugins install npm:openclaw-cls-agent-observability
```

**2. 配置导出凭证**(4 个环境变量,运行时注入,不要写进配置文件)

```bash
export CLS_ENDPOINT=https://ap-shanghai.cls.tencentcs.com   # 换成你的地域
export CLS_TRACE_TOPIC_ID=<Trace 日志主题 ID>
export CLS_SECRET_ID=<SecretId>
export CLS_SECRET_KEY=<SecretKey>
export CLS_CONTENT_MODE=truncate   # 建议:采集消息正文并截断;默认 off 只上报结构
```

> `CLS_TRACE_TOPIC_ID` 填 **Trace 日志主题 ID**,不是 Agent 应用 ID——这是
> 控制台无数据时的头号排查项。

**3. 确认 Hook 授权**(npm 通道必看)

非内置插件默认拿不到对话类 Hook,不授权则插件能加载但**零产出**。
`install.sh` 已自动写入;npm 通道安装后请确认 `openclaw.json` 含:

```json
{ "plugins": { "entries": { "cls-agent-observability": { "enabled": true,
  "hooks": { "allowConversationAccess": true } } } } }
```

**4. 重启 gateway,验证**

日志出现这行即成功:

```text
[plugins] CLS agent trace export enabled service=openclaw-gateway content=truncate
```

然后随便问 Agent 一个问题,CLS 控制台 → Agent 可观测 → 调用链里就能看到完整
Trace。

## 工作原理

插件通过 OpenClaw 的插件 Hook 拿到真实执行事件,镜像宿主的真实 span 树组装为
CLS 的五种 span:

```text
[entry] enter_application          一次提问(轮级输入/输出摘要)
└─ [agent] invoke_agent            整个 run(token 轮级聚合、终态)
   ├─ [step] react round_1         ReAct 第 1 轮
   │  ├─ [chat] chat               模型调用:输入上下文 → tool_call
   │  └─ [tool] tool_call          工具执行:参数 → 结果
   └─ [step] react round_2         ReAct 第 2 轮
      └─ [chat] chat               模型调用:工具结果 → 最终回答
```

- OpenClaw 在 `AsyncLocalStorage` 里维护真实 span id 并经 `ctx.trace` 转发,
  插件直接使用,**不做父子关系推导**
- 宿主 turn 作用域 ≠ CLS ReAct 轮:插件按模型/工具边界划分 `react round_n`,
  重试/failover 留在同一轮
- Subagent 的完成事件会唤醒父 agent 产生独立 turn,插件在其 entry 上标注
  `openclaw.turn.trigger=subagent_announce` 与来源 runId,两条 Trace 可互查

## 完整配置项

必填:

| 环境变量 | 说明 |
|---|---|
| `CLS_ENDPOINT` | CLS 地域 endpoint,仅接受官方域名,自动拼 `/v1/traces` |
| `CLS_TRACE_TOPIC_ID` | Trace 日志主题 ID |
| `CLS_SECRET_ID` / `CLS_SECRET_KEY` | 读取后立即从 `process.env` 删除,不会被子进程继承 |

正文与隐私:

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CLS_CONTENT_MODE` | `off` | `off` / `truncate` / `full`;`truncate` 推荐 |
| `CLS_CONTENT_MAX_CHARS` | `1100000` | 单字段截断上限,仅 `truncate` 生效 |
| `CLS_INPUT_MESSAGES_MODE` | `delta` | `delta`:会话首次全量、其后只报增量(前缀指纹校验,对不上自动回落全量);`full` 每次全量 |
| `CLS_SYSTEM_PROMPT_MODE` | `full` | system prompt 随首个完整上报发送一次;`hash` 只留指纹;`off` 不带 |
| `CLS_CAPTURE_ERROR_MESSAGES` | `false` | `true` 时上传工具错误正文 |
| `CLS_IDENTITY_MODE` | `hash` | `hash` / `raw` / `static`;`hash` 需配 `CLS_IDENTITY_HMAC_KEY` |

行为与资源上界(默认值按真实负载标定,容器化直接用 env 注入):

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CLS_SERVICE_NAME` | `openclaw-gateway` | 服务名 |
| `CLS_DEPLOYMENT_ENVIRONMENT` | — | 运行环境名 |
| `CLS_TRACE_SAMPLE_RATE` | `1` | 采样率 |
| `CLS_EXPORT_TIMEOUT_MS` | `10000` | 单次导出超时 |
| `CLS_EXPORT_DELAY_MS` | `5000` | 批量导出间隔 |
| `CLS_EXPORT_QUEUE_SIZE` | `2048` | 内存队列上限(满则丢弃) |
| `CLS_EXPORT_BATCH_SIZE` | `256` | 单批 span 数 |
| `CLS_STATE_MAX_ACTIVE_RUNS` | `1024` | 并发 run 上限(超出丢弃并计数) |
| `CLS_STATE_MAX_STEPS_PER_RUN` | `2048` | 单 run ReAct 轮数上限 |
| `CLS_STATE_RUN_IDLE_MS` | `7200000` | 无活动 run 收敛时限 |
| `CLS_ATTEMPT_QUIESCENCE_MS` | `5000` | 模型 attempt 重试等待窗口 |

> 内存的主项不是元数据而是会话文本:每个活跃 run 镜像模型上下文,上界≈
> 上下文窗口(0.5~4M 字符)。估算容器内存用「并发 run 数 × 上下文大小」。
>
> 配置缺失时插件保持休眠,不影响 gateway 启动;非法值(如
> `CLS_CONTENT_MODE=truncated` 笔误)会打 warn 日志,不静默回退。

## 部署

容器 / TKE initContainer / systemd / 离线内网的完整示例见
[docs/deployment.md](docs/deployment.md)——含「打进镜像、gateway 拉起即启用」
的 Dockerfile 与 K8s YAML。

## 兼容性

| 项 | 支持范围 |
|---|---|
| OpenClaw | `v2026.6.5` 与 `v2026.7.1-2`,发版前双版本 E2E 门禁全过才放行 |
| Hook 能力差异 | 逐条降级并告警,不炸宿主;明细见 [docs/compatibility.md](docs/compatibility.md) |

## 排障

1. **控制台无数据** → 先核对 `CLS_TRACE_TOPIC_ID` 是 Trace 主题 ID 而非应用 ID;
   再看启动日志有没有 `export enabled`
2. **日志出现 `typed hook ... blocked ... allowConversationAccess`** → 缺 Hook
   授权,按「快速开始」第 3 步补配置
3. **有结构没正文** → `CLS_CONTENT_MODE` 未开启(默认 `off`)
4. **Token 图表缺失** → chat span 的 `gen_ai.usage.*` 才有逐调用值,控制台
   Tokens 列读的就是它;失败的模型调用可能只有零值(以 degraded 标记,不伪造)
5. **`hooks unavailable on this host` 告警** → 宿主版本过旧,部分能力降级,
   对照 docs/compatibility.md

## 安全边界

- 默认不采集 Prompt、模型输出、工具参数与结果
- 错误正文默认不上传,只上传低基数 `error.type`
- 用户标识默认 HMAC 后上传
- 密钥读取后立即从环境变量删除
- Endpoint 限制 CLS 官方域名,防止凭据外发
- 私有 TracerProvider,不污染全局 OTel 状态,可与官方 exporter 并存

## 开发

```bash
npm install
npm test              # 单测 + 真实流量回放 + 协议校验
npm run pack:dist     # 产出零依赖 bundle 与 tarball(dist/、dist-bundle/)
npm run e2e           # 真实 gateway 端到端(宿主自动从 npm 拉取,需 DEEPSEEK_API_KEY)
sh scripts/compat-matrix.sh   # 双宿主版本冒烟(发布门禁)
```

## 许可证

Apache-2.0,见 [LICENSE](LICENSE)。
