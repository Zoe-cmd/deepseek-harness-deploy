# DeepSeek Harness，只给你想给的人用

> 把 DeepSeek Harness 包进「认证网关 + TLS 反向代理」，一个 Access Token 决定谁能用，
> Harness 本身只活在回环地址里，公网永远够不着它。

**30 秒部署 → 31 项安全测试全过 → 浏览器输入 token 即用。**

---

## 为什么要做这个

DeepSeek Harness 是强大的 AI 研发代理，但它默认的设计是**「绑定本机浏览器」**：

- 谁拿到地址就能打开 —— **没有任何认证**
- `dsh web` 只监听本机回环 —— **没法给同事、团队、远程设备用**
- 想对外暴露？得用 `--trusted-host` 把信任围栏撕开 —— **暴露全量管理/凭证 API**
- 想要登录、会话、防爆破？**官方根本没提供**

于是有了这个仓库：**它不改造 Harness 一行代码**，而是在前面立一道独立的门。

```
浏览器 ──:443 HTTPS──▶ Nginx ──▶ Auth Gateway(127.0.0.1:3081) ──▶ Harness(127.0.0.1:3080)
                        │              │                              │
                     TLS 终止        Token 认证 / 会话 / 限流 / 代理    仅回环，永不公网
                     WS/SSE 透传
```

## 解决了什么

| 痛点 | 方案 |
|---|---|
| 没有认证，谁都能用 | 登录页输入 Access Token，签发 `HttpOnly+Secure+SameSite=Lax` 会话 Cookie |
| 只有本机能访问 | nginx 做唯一公网入口，回环上的 Harness 反而不暴露 |
| `--trusted-host` 撕开安全围栏 | 网关把上游 `Host` 重写为回环并剥离 `Origin/Cookie/Authorization`，特权 API 全可用、**无需 `--trusted-host`** |
| 暴力破解登录 | 按 IP 限流：10 次失败 / 15 分钟，超限封禁并返回 429 |
| 管理/凭证 API 泄漏风险 | 全站 31 项自动化测试兜底，登录页严格 CSP、常数时间 Token 比对 |
| 日志泄漏密钥 | 日志只记 IP 与路由，不记任何令牌/会话 ID |

## 特性一览

- **零依赖网关**：仅用 `node:http/crypto`，几十 KB，无第三方包、无供应链风险
- **会话安全**：HMAC 签名、空闲过期 + 滑动续期 + 绝对寿命封顶、可选 IP 绑定
- **全协议透传**：HTTP、WebSocket（`/api/events.*`）、SSE 长连接
- **三重防线**：网络隔离（回环绑定）+ 认证授权（Token/会话）+ CSRF 校验
- **一键运维**：`start/stop/status/logs/restart` 脚本，可选 systemd / Docker Compose
- **可验证**：`security-test.sh` 跑 31 项功能+安全矩阵，全绿才算上线

## 目录结构

```
├── deploy/
│   ├── auth-gateway/         认证网关源码（零依赖 Node ESM）
│   │   ├── server.mjs        入口：/healthz /login /logout + 会话校验代理(HTTP/WS)
│   │   ├── config.mjs        .env 加载与校验（fail-fast）
│   │   ├── session.mjs       会话存储（HMAC、滑动过期、IP 绑定）
│   │   ├── auth.mjs          常数时间 Token 比对 + 登录限流
│   │   ├── proxy.mjs         HTTP/WS 代理：Host 重写、请求头剥离、安全响应头
│   │   ├── views.mjs         登录页/错误页（严格 CSP、HTML 转义）
│   │   └── Dockerfile        可选的容器镜像
│   ├── nginx/
│   │   ├── nginx-gateway.conf         生产站点（安装到系统 nginx）
│   │   ├── nginx-gateway-test.conf     独立测试实例（:8080/:8443，相对路径 + -p）
│   │   └── gen-cert.sh                自签名证书生成（支持 PUBLIC_IP SAN）
│   ├── scripts/
│   │   ├── start.sh | stop.sh | restart.sh | status.sh | logs.sh
│   │   └── security-test.sh           31 项功能+安全测试矩阵
│   ├── systemd/               dsh-harness.service / dsh-auth-gateway.service
│   ├── docker-compose.yml    （可选）网关+nginx 容器化
│   ├── .env.example          配置模板（复制为 .env 后填写）
│   └── .token                Harness 访问令牌备份（gitignore，禁止提交）
├── harness-run/              Harness 启动元数据
├── package.json              根包（workspace 用）
└── README.md                 本文件
```

## 快速开始（本机 / 局域网）

前置要求：`node >= 18`；`node_modules` 已装 `@deepseek-ai/dsh`；有一个 Access Token。

```bash
# 1. 配置
cp deploy/.env.example deploy/.env
#    编辑 deploy/.env 填写 HARNESS_ACCESS_TOKEN（必填）、SESSION_SECRET 等
#    建议：openssl rand -hex 32

# 2. 生成证书并安装生产 nginx 站点
bash deploy/nginx/gen-cert.sh
sudo cp deploy/nginx/nginx-gateway.conf /etc/nginx/conf.d/harness-gateway.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. 启动整栈（harness + 网关；nginx 由 systemd 管理）
bash deploy/scripts/start.sh --no-nginx

# 4. 验证
bash deploy/scripts/status.sh
bash deploy/scripts/security-test.sh https://127.0.0.1
```

浏览器访问 `https://<服务器IP>`，登录页输入 Access Token 即进入 Harness。
自签名证书需在浏览器手动信任（先访问一次并“继续前往”）。

### 仅本机快速试用（不动系统 nginx）

```bash
bash deploy/scripts/start.sh            # 默认 --nginx-test：:8080/:8443
# 访问 https://127.0.0.1:8443
bash deploy/scripts/stop.sh             # 停止整栈
```

## 公网部署（云服务器）

1. **云控制台安全组**：放行 `TCP 80`、`TCP 443`（NAT EIP 还需确认转发到实例）。
   `IP:3080/3081` 不必放行——它们只绑回环。
2. **证书 SAN 加入公网 IP**（地址栏访问 IP 不告警）：

   ```bash
   PUBLIC_IP=<你的公网IP> bash deploy/nginx/gen-cert.sh
   sudo cp deploy/certs/harness.{crt,key} /etc/nginx/certs/
   sudo nginx -s reload
   ```

3. **部署 nginx 站点**（同上“快速开始”第 2 步）。

证书 SAN 含公网 IP 后，浏览器访问 `https://<你的公网IP>` 即不再告警。

## 配置说明（deploy/.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS_ACCESS_TOKEN` | （必填） | 访问令牌；缺失则网关启动失败（fail-fast） |
| `SESSION_SECRET` | 随机 | 会话 ID 的 HMAC 密钥；未设置则每次启动随机，重启后会话失效 |
| `SESSION_EXPIRE_SECONDS` | `86400` | 会话空闲过期（最短 5 秒，便于测试） |
| `SESSION_MAX_LIFETIME_SECONDS` | `604800` | 会话绝对最大寿命，滑动续期也封顶 |
| `SESSION_SLIDING` | `1` | 1=每次请求滑动续期 |
| `SESSION_BIND_IP` | `0` | 1=会话绑定登录时 IP（IP 变化强制登出） |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3081` | 网关监听地址（必须回环） |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `3080` | Harness 上游地址（必须回环） |
| `COOKIE_SECURE` | `1` | Cookie 加 `Secure`（HTTPS 必须 1） |
| `RATE_LIMIT_MAX` | `10` | 窗口内最大登录失败次数 |
| `RATE_LIMIT_WINDOW_MS` | `900000` | 限流窗口（15 分钟） |
| `RATE_LIMIT_BAN_MS` | `900000` | 超限后封禁时长 |
| `TRUST_PROXY` | `1` | 信任 nginx 的 X-Forwarded-For（网关仅回环，安全） |
| `SESSION_COOKIE_NAME` | `dsh_session` | 会话 Cookie 名 |

## 安全设计

### 网络隔离
- Harness `127.0.0.1:3080`、网关 `127.0.0.1:3081` 仅回环绑定；公网端口直连被拒
  （`security-test.sh` 第 10 组验证）。
- nginx 覆盖 `X-Forwarded-For` 为真实客户端 IP，无法伪造来源绕过限流。

### 认证与会话
- 常数时间 Token 比对（`crypto.timingSafeEqual`），防时序侧信道。
- 会话 Cookie：`HttpOnly + Secure + SameSite=Lax + Path=/`；退出 `Max-Age=0`。
- 登录限流：10 次失败 / 15 分钟，超限封禁，返回 429 + `Retry-After`。
- Token 永不写进 HTML/JS/日志。

### CSRF 防护（`originAllowed`）
- 无 `Origin`（curl 等）→ 放行；
- `Origin` 为具体源 → 只比 **hostname**（不比较端口：地址栏带 `:443` 时 Origin 含端口，
  而 nginx `$host` 剥掉端口，二者同源）；
- `Origin: null`（隐私模式 / 严格 referrer-policy 表单）→ 回退校验 `Referer` hostname，
  同源才放行；跨站攻击者无法伪造一致的 Referer。
  登录页因此用 `referrer-policy: strict-origin-when-cross-origin`。

### 上游信任围栏（proxy.mjs）
- 重写 `Host: 127.0.0.1:3080`（客户端传入的 `Host` 一律覆盖）；
- 剥离 `Origin / Cookie / Authorization`（会话只认网关自己的 Cookie）；
- 保留 WebSocket 握手字段并透传升级。

### 安全响应头
- 全部响应：nosniff、`X-Frame-Options: DENY`、COOP、CSP、Referrer-Policy。
- 登录页：严格 CSP（`script-src 'self'`，无 inline script）+ `no-store`。
- 代理页 CSP 含 `'unsafe-eval'`：Harness 前端 bundle（Cordis/schemastery）依赖
  `new Function`，缺失会白屏；该放宽只作用于已认证代理响应。

## 运维

```bash
bash deploy/scripts/start.sh             # 一键启动（harness + 网关 + 测试 nginx）
bash deploy/scripts/status.sh            # 进程与端口状态 + healthz 探测
bash deploy/scripts/logs.sh              # 实时日志（gateway|harness|nginx|all）
bash deploy/scripts/restart.sh           # 重启
bash deploy/scripts/stop.sh              # 停机
```

### systemd（推荐生产）

```bash
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dsh-harness dsh-auth-gateway
```

> unit 里的 `WorkingDirectory`/`ExecStart` 指向 `/root/app`，请按实际检出位置修改。

### Docker Compose（可选）

网关 + nginx 容器化（需宿主机 80/443 空闲，Harness 保持宿主机原生运行）：

```bash
bash deploy/nginx/gen-cert.sh
docker compose -f deploy/docker-compose.yml up -d --build
```

## 安全测试

```bash
bash deploy/scripts/security-test.sh https://127.0.0.1
```

共 **31 项**：未认证重定向/401、Cookie 篡改/删除/失效、登录后全路由（含特权
`settings.describe`）、会话刷新/退出、网络隔离（回环绑定）、WebSocket 101 vs 401、
暴力破解 429、安全响应头、登录页严格 CSP、SSE 透传。

## 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录提交 `{"error":"forbidden"}` | 浏览器 `Origin` 与校验不一致（带端口或 `null`） | 确认网关跑的是 hostname-only + Referer 兜底的 `originAllowed`；刷新网关 |
| 登录后首页白屏 | 代理页 CSP 缺 `unsafe-eval`，`new Function` 被拦 | `proxy.mjs` 的 `script-src` 必须含 `'unsafe-eval'`；强刷浏览器 |
| 登录成功但 API 403 | 上游 `Host` 未被重写为回环，破坏信任围栏 | `upstreamHeaders` 必须覆盖客户端 `Host` |
| 外网访问不通（502/超时） | 云安全组/EIP 未放行 80/443 | 云控制台放行 `TCP 80,443` 并确认 EIP 转发 |
| 浏览器证书告警 | 自签名证书 SAN 不含访问 IP | `PUBLIC_IP=<IP> bash deploy/nginx/gen-cert.sh` 后重装并 reload |
| 重启后会话全失效 | `SESSION_SECRET` 未设置（每次随机） | 在 `.env` 固定 `SESSION_SECRET` |

## 安全注意事项

- 生产请替换为真实 CA 证书（Let's Encrypt / 云厂商），之后再启用 HSTS。
- **永远不要提交** `deploy/.env`、`deploy/.token`、`deploy/certs/`（已 gitignore）。
- `HARNESS_ACCESS_TOKEN` 与 `SESSION_SECRET` 用 `openssl rand -hex 32` 生成。
- Harness 上游升级后，先跑一遍 `security-test.sh` 再开放流量。

## License

部署与网关代码为示例/运维实现，可自由使用；DeepSeek Harness 遵循其上游许可证。