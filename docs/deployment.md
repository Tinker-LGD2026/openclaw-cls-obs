# 部署与集成指南

插件以零依赖 bundle 分发,各部署形态共用同一个 `plugin.tar.gz`。

- 产物布局(COS):`agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/<version>/{plugin.tar.gz,SHA256SUMS,install.sh,uninstall.sh}`,`latest/` 指向最新版
- npm 通道:`openclaw plugins install npm:openclaw-cls-agent-observability`
- 配置:环境变量**或** `openclaw.json` 的 `plugins.entries.cls-agent-observability.config`
  (v0.2.0 起;env 优先、文件兜底,文件修改热更新),键名见插件 README 配置表
- 必需:`CLS_ENDPOINT` `CLS_TRACE_TOPIC_ID` `CLS_SECRET_ID` `CLS_SECRET_KEY`
  (或文件形式的 `endpoint`/`traceTopicId`/`secretId`/`secretKey`);
  建议 `CLS_CONTENT_MODE=truncate`

## 1. 容器(Docker / TKE)

### Dockerfile(基于客户自己的 OpenClaw 镜像)

```dockerfile
# 构建期拉取并安装插件,目标:gateway 拉起即启用。
# 生产建议钉具体版本(如 0.2.0),latest 仅适合试用。
# 显式钉 state dir:install.sh 装到构建用户的 $HOME/.openclaw,而运行期 USER
# 可能是非 root 用户——统一指向固定路径,构建/运行两侧都可见。
#
# 注意:此方案把插件烤进镜像层。若你要在 OPENCLAW_STATE_DIR 挂持久卷
# ( PV 会遮住镜像内容),请改用下面的 initContainer 变体。
ARG CLS_OBS_VERSION=0.2.0
ARG CLS_OBS_COS_BASE_URL=https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability
ENV OPENCLAW_STATE_DIR=/var/lib/openclaw
# 1) 插件文件;2) 启用配置(含 conversation Hook 授权,缺了插件零产出)。
#    配置用幂等合并显式写入,不依赖构建期 CLI 是否在 PATH。
RUN curl -fsSL "$CLS_OBS_COS_BASE_URL/$CLS_OBS_VERSION/install.sh" \
      | CLS_OBS_COS_BASE_URL="$CLS_OBS_COS_BASE_URL" sh -s "$CLS_OBS_VERSION" \
 && node -e '
    const fs = require("fs");
    const p = process.env.OPENCLAW_STATE_DIR + "/openclaw.json";
    const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    cfg.plugins = cfg.plugins || {};
    cfg.plugins.entries = {
      ...(cfg.plugins.entries || {}),
      "cls-agent-observability": {
        enabled: true,
        hooks: { allowConversationAccess: true },
      },
    };
    fs.mkdirSync(require("path").dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  '
```

运行期注入配置(Deployment env):

```yaml
env:
  - name: CLS_ENDPOINT
    value: https://ap-shanghai.cls.tencentcs.com
  - name: CLS_TRACE_TOPIC_ID
    value: <topic-id>
  - name: CLS_CONTENT_MODE
    value: truncate
  - name: CLS_SECRET_ID
    valueFrom: { secretKeyRef: { name: cls-credentials, key: secretId } }
  - name: CLS_SECRET_KEY
    valueFrom: { secretKeyRef: { name: cls-credentials, key: secretKey } }
```

### TKE initContainer 变体(不改主镜像)

```yaml
initContainers:
  - name: cls-obs-plugin
    image: curlimages/curl:8.10.1
    env:
      - name: CLS_OBS_COS_BASE_URL
        value: https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability
    command:
      - sh
      - -c
      - |
        set -eu
        cd /tmp
        curl -fsSL "$CLS_OBS_COS_BASE_URL/latest/plugin.tar.gz" -o plugin.tar.gz
        curl -fsSL "$CLS_OBS_COS_BASE_URL/latest/SHA256SUMS" -o SHA256SUMS
        sha256sum -c SHA256SUMS
        mkdir -p /openclaw-state/extensions/cls-agent-observability
        tar -xzf plugin.tar.gz -C /openclaw-state/extensions/cls-agent-observability
        # 启用配置(含 conversation Hook 授权)。卷是空卷时 openclaw.json 不存在,
        # 直接写入;客户已有配置时请改用带 node 的镜像做幂等合并(见 Dockerfile 示例)。
        if [ ! -f /openclaw-state/openclaw.json ]; then
          cat > /openclaw-state/openclaw.json <<'JSON'
{"plugins":{"entries":{"cls-agent-observability":{"enabled":true,"hooks":{"allowConversationAccess":true}}}}}
JSON
        fi
    volumeMounts: [{ name: openclaw-state, mountPath: /openclaw-state }]
```

主容器必须挂同一个 `openclaw-state` 卷,**并显式指向它**,同时注入 CLS 配置
(env 同上方 Dockerfile 一节的 `env` 块):

```yaml
volumeMounts: [{ name: openclaw-state, mountPath: /openclaw-state }]
env:
  - name: OPENCLAW_STATE_DIR
    value: /openclaw-state
  # ... 以及 CLS_ENDPOINT / CLS_TRACE_TOPIC_ID / CLS_CONTENT_MODE / 凭证 secretKeyRef
```

不设置 `OPENCLAW_STATE_DIR` 时 OpenClaw 在 `$HOME/.openclaw` 下发现插件,卷里的
插件不会被加载。国内集群拉取 docker.io 受阻时,把 `curlimages/curl` 换成你的
镜像仓库 mirror。

## 2. CVM / 物理机(systemd)

**用运行 gateway 的同一个用户执行安装**(插件装到该用户的 `$HOME/.openclaw`;
装到 root 而服务跑在别的用户下是经典坑):

```bash
curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/install.sh | sh
```

drop-in(目录名按你的 unit 名调整,这里假设 `openclaw-gateway.service`)
`/etc/systemd/system/openclaw-gateway.service.d/cls-obs.conf`:

```ini
[Service]
Environment=CLS_ENDPOINT=https://ap-shanghai.cls.tencentcs.com
Environment=CLS_TRACE_TOPIC_ID=<topic-id>
Environment=CLS_CONTENT_MODE=truncate
EnvironmentFile=/etc/openclaw/cls-credentials.env
```

`/etc/openclaw/cls-credentials.env`(chmod 600):

```bash
CLS_SECRET_ID=...
CLS_SECRET_KEY=...
```

生效:

```bash
systemctl daemon-reload && systemctl restart openclaw-gateway
```

## 3. 离线/内网

把 `plugin.tar.gz` 与 `SHA256SUMS` 转运到内网制品库,手动安装:

```bash
mkdir -p ~/.openclaw/extensions/cls-agent-observability
sha256sum -c SHA256SUMS   # 文件需命名为 plugin.tar.gz
tar -xzf plugin.tar.gz -C ~/.openclaw/extensions/cls-agent-observability
```

手动安装没有 install.sh 的配置写入步骤,**必须按 §5 补上插件授权配置**,
否则插件加载但零产出。

## 4. 升级与卸载

- 升级/回滚:重跑 install.sh 并带版本号,解包前会校验哈希并清空旧目录:

  ```bash
  curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/install.sh | sh -s 0.2.0
  ```

- 卸载(不修改你的配置;若 `plugins.allow`/`entries` 里有残留引用会提示手动移除):

  ```bash
  curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/uninstall.sh | sh
  ```

- 两种操作都需要重启 gateway 生效

## 5. 必需的插件配置

非 bundled 插件默认拿不到 conversation 类 Hook(`llm_input`、`before_agent_run`
等)——不授权的话插件能加载但什么都不上报。`install.sh` 在 CLI 可用时会自动
写入(并保留你已有的白名单与其他插件配置);手动安装或 CLI 不在场时,确认
`openclaw.json` 里有:

```json
{
  "plugins": {
    "entries": {
      "cls-agent-observability": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

若配置了 `plugins.allow` 白名单,还需包含 `"cls-agent-observability"`。
判断依据:日志出现 `typed hook ... blocked because non-bundled plugins must set
...allowConversationAccess=true` 即为缺授权。

## 6. 验证安装

重启后日志应出现(含一行脱敏的生效配置摘要,排障先看它):

```text
[plugins] cls observability effective config: endpoint=... topic=... content=truncate ...
[plugins] CLS agent trace export enabled service=openclaw-gateway content=truncate
```

之后随便问 Agent 一个问题,CLS 控制台 → Agent 可观测 → 调用链应能看到完整
Trace。默认每 5 分钟还有一行 `cls observability stats {...}` 自观测日志。

配置非法值会有 warn 日志;Hook 不可用的旧宿主会逐条降级并告警。
