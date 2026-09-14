# 数据分级说明:每个模式把什么数据发到哪里

供安全/合规评审使用。目的地只有一个:你配置的 **CLS Trace 日志主题**
(`CLS_TRACE_TOPIC_ID`,腾讯云 CLS,你的账号下)。数据不经过任何第三方,
插件与 CLS 之间是标准 OTLP/HTTP + Basic Auth(你的 SecretId/Key)。

## 按内容模式分级

| 数据类别 | `off`(默认) | `truncate`(推荐) | `full` |
|---|---|---|---|
| 调用拓扑(turn/轮/调用/工具的层级与耗时) | ✅ 发送 | ✅ | ✅ |
| 模型名、provider、token 用量、成本估算 | ✅ 发送 | ✅ | ✅ |
| 错误类型(低基数 `error.type`,如 `nonzero_exit`) | ✅ 发送 | ✅ | ✅ |
| 工具名与调用 ID | ✅ 发送 | ✅ | ✅ |
| 用户/会话标识 | HMAC 假名¹ | 同左 | 同左 |
| system prompt 指纹(sha256 + 长度) | ✅ 发送 | ✅ | ✅ |
| **用户提问、模型回答正文** | ❌ 不发送 | ✅ 截断² | ✅ 完整 |
| **system prompt 正文** | ❌ | ✅ 截断²(可降为指纹或关闭³) | ✅ 完整(含思维链前缀) |
| **工具参数与结果正文**(可能含文件内容、命令输出) | ❌ | ✅ 截断² | ✅ 完整 |
| 工具错误正文(可能含堆栈、路径) | ❌ | 默认仍不发⁴ | 默认仍不发⁴ |

¹ `CLS_IDENTITY_MODE=hash`(默认)时用你的 `identityHmacKey` 做域分隔 HMAC;
`raw` 发送原文,`static` 发送固定值。
² 单字段上限 `CLS_CONTENT_MAX_CHARS`(默认 1.1M 字符),截断事件本身会记录
(`*.truncated`)。**截断不是脱敏**:命中内置密钥模式的内容会被替换并记录
`*.redacted_types`,但自定义敏感格式(工号、内部域名)不在内置规则内。
³ `CLS_SYSTEM_PROMPT_MODE=hash` 只发指纹,`off` 完全不发。
⁴ `CLS_CAPTURE_ERROR_MESSAGES=true` 才发送。

## `full` 模式的出域清单(评审重点)

开启 `full` 意味着以下内容**完整、未截断**地离开你的主机,写入 CLS:

- 全部用户输入与会话历史(含模型思维链,如果模型返回)
- 全部工具参数与输出——对 OpenClaw 来说这**包括文件读写内容、shell 命令
  及其输出、浏览器抓取内容**,即 Agent 能接触到的一切
- system prompt 全文(通常含你的产品内部指令)

建议:`full` 只用于受控调试;生产用 `truncate` 并把
`CLS_CONTENT_MAX_CHARS` 调到业务可接受的下限。

## 访问控制边界

- 数据落在你的 CLS 主题,谁能看由你的 CLS/CAM 权限决定
- 插件密钥读取后立即从 `process.env` 删除,Agent 工具子进程继承不到
- endpoint 被限制为 CLS 官方域名,凭据不会发往其他主机
- 插件不读、不存、不转发 openclaw.json 里的任何其他配置
