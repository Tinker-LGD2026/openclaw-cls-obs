# 运维手册:重启语义与字段可靠性

本文回答一个问题:**gateway / 插件重启之后,CLS 里的数据会变成什么样,哪些
字段可以继续信赖。**

## 重启后你会看到什么

| 现象 | 原因 | 是否正常 |
|---|---|---|
| 重启那一刻正在执行的 run,trace 提前"结束" | 进程退出前插件会兜底收尾所有在途 span | 正常 |
| 同一个会话重启后的第一轮,chat 输入从增量(delta)退回全量 | 增量游标是进程内存态,重启后无前缀可校验 | 正常,一次性 |
| 会话的轮次编号(t1/t2…)从 1 重新计 | 轮次计数器是进程内存态 | 正常 |
| 正在执行的模型流式调用丢失尾部 | 进程已退出,该调用以当前已知状态收尾 | 正常 |

## 跨重启可以信赖的字段

- **`openclaw.run.id`**:run 的身份由宿主生成并贯穿重启(只要宿主会话在),
  按它检索可以把重启前后的 trace 关联到同一次执行
- **`gen_ai.session.id`**:会话标识,跨重启稳定
- **`openclaw.input.system.sha256`**:system prompt 指纹,用于判断部署间 prompt
  是否变化,与重启无关
- token 数值:已落库的 span 不受影响;**重启瞬间在途的调用** usage 可能缺失
  或为零值(以 `openclaw.observation.degraded` 标记,不伪造)

## 跨重启不可依赖的行为

- **增量链**:重启后首次上报必为全量,不要因为"delta 突然变大"告警
- **轮次序号**:只在单进程生命期内单调;跨进程比较轮次请用 `openclaw.run.id` +
  span 时间戳排序
- **stats 计数**:`cls observability stats` 里的 ingested/dropped 是进程期计数,
  重启清零,做告警时请按速率(rate)而非累计值

## 配置热更新(不需要重启)

修改 `openclaw.json` 里 `plugins.entries.cls-agent-observability.config` 后,
宿主会热重载插件:日志出现 `CLS configuration changed; restarting the exporter`
加一行新的 `effective config` 摘要即生效。**环境变量不热更**——env 变更需要
重启 gateway 进程。

## 进程内存的上界(容量规划)

- 每个活跃 run 镜像一份模型会话上下文,上界≈上下文窗口(0.5~4M 字符);
  容器内存估算用「并发 run 数 × 上下文大小」
- 游标/计数器元数据每条仅数百字节,`CLS_STATE_*` 上限防的是异常堆积,
  不是常规负载
