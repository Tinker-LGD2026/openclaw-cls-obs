# 部署与集成指南

插件以零依赖 bundle 分发,三种部署形态共用同一个 `plugin.tar.gz`。

- 产物布局(COS):`<bucket>/cls-agent-observability/<version>/{plugin.tar.gz,SHA256SUMS,install.sh,uninstall.sh}`,`latest/` 指向最新版
- npm 通道:`openclaw plugins install npm:openclaw-cls-agent-observability`
- 配置:全部经环境变量,见插件 README 的配置表
- 必需变量:`CLS_ENDPOINT` `CLS_TRACE_TOPIC_ID` `CLS_SECRET_ID` `CLS_SECRET_KEY`;
  建议 `CLS_CONTENT_MODE=truncate`

## 1. 容器(Docker / TKE)

### Dockerfile(基于客户自己的 OpenClaw 镜像)

```dockerfile
# 构建期拉取并安装插件(版本钉住,构建可复现),目标:gateway 拉起即启用。
# 显式钉 state dir:install.sh 装到构建用户的 $HOME/.openclaw,而运行期 USER
# 可能是非 root 用户——统一指向固定路径,构建/运行两侧都可见。
ARG CLS_OBS_VERSION=latest
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

主容器必须挂同一个 `openclaw-state` 卷,**并显式指向它**:

```yaml
env:
  - name: OPENCLAW_STATE_DIR
    value: /openclaw-state
```

不设置 `OPENCLAW_STATE_DIR` 时 OpenClaw 在 `$HOME/.openclaw` 下发现插件,卷里的
插件不会被加载。

## 2. CVM / 物理机(systemd)

```bash
curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/install.sh | sh
```

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

## 3. 离线/内网

把 `plugin.tar.gz` 与 `SHA256SUMS` 转运到内网制品库,手动安装:

```bash
mkdir -p ~/.openclaw/extensions/cls-agent-observability
sha256sum -c SHA256SUMS   # 文件需命名为 plugin.tar.gz
tar -xzf plugin.tar.gz -C ~/.openclaw/extensions/cls-agent-observability
```

## 4. 升级与卸载

- 升级:重跑 install.sh(指定版本号可回滚:`install.sh <version>`);解包前会校验
  哈希并清空旧目录
- 卸载:`uninstall.sh`(不修改客户配置;若曾加入 `plugins.allow`,按提示手动移除)
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

重启后日志应出现:

```text
[plugins] CLS agent trace export enabled service=openclaw-gateway content=truncate
```

配置非法值会有 warn 日志;Hook 不可用的旧宿主会逐条降级并告警。
