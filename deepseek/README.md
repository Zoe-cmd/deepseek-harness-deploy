# DeepSeek Harness 安全部署（Auth Gateway）

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 部署在
**认证网关 + TLS 反向代理**之后。Harness 自身只监听回环地址、永不暴露公网，
访问凭据、会话、限流与 TLS 全部由独立网关与 nginx 承担。

```
浏览器 ──:443 HTTPS──▶ Nginx ──▶ Auth Gateway(127.0.0.1:3081) ──▶ Harness(127.0.0.1:3080)
                        │              │                              │
                     TLS 终止        Token 认证 / 会话 / 限流 / 代理    仅回环，永不公网
                     WS/SSE 透传
```

## 一、组件与职责

| 组件 | 监听 | 职责 |
|---|---|---|
| **Harness** | `127.0.0.1:3080` | 官方 `@deepseek-ai/dsh` Web 服务，仅回环 |
| **Auth Gateway** | `127.0.0.1:3081` | 零依赖 Node ESM 进程：Token 登录、会话 Cookie、防爆破限流、HTTP/WS 反向代理 |
| **Nginx** | `:80/:443` | 唯一公网入口；TLS 终止、HTTP→HTTPS 301、WebSocket 升级透传、SSE 长连接 |

网关代理请求时会把上游 `Host` 重写为 `127.0.0.1:3080` 并剥离
`Origin/Cookie/Authorization`，从而满足 Harness 的“浏览器信任围栏”
（loopback-trust），因此全部 API——包括管理类与凭证类接口——都可用，
**无需** `--trusted-host`；WebSocket（`/api/events.mux`、`/api/events.host`）
与 SSE 正常透传。

## 二、目录结构

```
deepseek/
├── deploy/
│   ├── auth-gateway/         认证网关源码（零依赖，仅 node:http/crypto）
│   │   ├── server.mjs        入口：/healthz /login /logout + 会话校验代理(HTTP/WS)
│   │   ├── config.mjs        .env 加载与校验（fail-fast）
│   │   ├── session.mjs       会话存储（HMAC 摘要、滑动过期、IP 绑定）
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
│   ├── .env                  实际配置（gitignore，禁止提交）
│   └── .token                Harness 访问令牌备份（gitignore，禁止提交）
├── harness-run/              Harness 启动元数据
├── package.json              根包（workspace 用）
└── README.md                 本文件
```

## 三、快速开始（本机 / 局域网）

前置要求：`node >= 18`（开发机为 node 22）；已在 `node_modules` 安装
`@deepseek-ai/dsh`；有一个可用的 Access Token。

```bash
# 1. 配置
cp deploy/.env.example deploy/.env
#    编辑 deploy/.env 填写 HARNESS_ACCESS_TOKEN（必填）、SESSION_SECRET 等
#    建议：openssl rand -hex 32

# 2. 生成证书并安装生产 nginx 站点
bash deploy/nginx/gen-cert.sh
sudo cp deploy/nginx/nginx-gateway.conf /etc/nginx/conf.d/harness-gateway.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. 启动整栈（harness + 网关；nginx 已由 systemd 管理）
bash deploy/scripts/start.sh --no-nginx

# 4. 验证
bash deploy/scripts/status.sh
bash deploy/scripts/security-test.sh https://127.0.0.1
```

浏览器访问 `https://<服务器IP>`，在登录页输入 Access Token 后进入 Harness 界面。
自签名证书需在浏览器中手动信任（先访问一次并“继续前往”）。

### 仅本机快速试用（不动系统 nginx）

```bash
bash deploy/scripts/start.sh            # 默认 --nginx-test：:8080/:8443
# 访问 https://127.0.0.1:8443
bash deploy/scripts/stop.sh             # 停止整栈
```

## 四、公网部署（云服务器）

Nginx 只监听 `:80/:443`；Harness 与网关永不绑定公网接口。除本仓库外还需：

1. **云控制台安全组**：放行入方向 `TCP 80`、`TCP 443`（若使用 NAT EIP 还需确认
   EIP 转发到实例；仅 `IP:3080/3081` 不应放行——它们本来就只绑回环）。
2. **证书 SAN 加入公网 IP**（浏览器地址栏访问 IP 时不告警）：

   ```bash
   PUBLIC_IP=<你的公网IP> bash deploy/nginx/gen-cert.sh
   sudo cp deploy/certs/harness.{crt,key} /etc/nginx/certs/
   sudo nginx -s reload
   ```

3. **部署 nginx 站点**（同上“快速开始”第 2 步）。

本仓库当前线上实例：
- 公网入口 `https://<公网IP>`（NAT EIP，`eip_direct=false`）
- 证书 `deploy/certs/harness.crt`（SAN 含 `IP:<公网IP>`）
- 生产站点 `/etc/nginx/conf.d/harness-gateway.conf`

## 五、配置说明（deploy/.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS_ACCESS_TOKEN` | （必填） | 访问令牌；缺失则网关启动失败（fail-fast） |
| `SESSION_SECRET` | 随机 | 会话 ID 的 HMAC 密钥；未设置则每次启动随机，重启后全部会话失效 |
| `SESSION_EXPIRE_SECONDS` | `86400` | 会话空闲过期（最短 5 秒，便于测试） |
| `SESSION_MAX_LIFETIME_SECONDS` | `604800` | 会话绝对最大寿命，滑动续期也封顶 |
| `SESSION_SLIDING` | `1` | 1=每次请求滑动续期 |
| `SESSION_BIND_IP` | `0` | 1=会话绑定登录时的来源 IP（IP 变化强制登出） |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3081` | 网关监听地址（必须回环） |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `3080` | Harness 上游地址（必须回环） |
| `COOKIE_SECURE` | `1` | 会话 Cookie 加 `Secure`（HTTPS 必须 1） |
| `RATE_LIMIT_MAX` | `10` | 窗口内最大登录失败次数 |
| `RATE_LIMIT_WINDOW_MS` | `900000` | 限流窗口（15 分钟） |
| `RATE_LIMIT_BAN_MS` | `900000` | 超限后的封禁时长 |
| `TRUST_PROXY` | `1` | 信任 nginx 设置的 X-Forwarded-For（网关仅回环，安全） |
| `SESSION_COOKIE_NAME` | `dsh_session` | 会话 Cookie 名 |

## 六、安全设计

### 6.1 网络隔离
- Harness `127.0.0.1:3080`、网关 `127.0.0.1:3081` 仅回环绑定；公网
  `IP:3080/3081` 直接拒绝连接（`security-test.sh` 第 10 组验证）。
- nginx 覆盖 `X-Forwarded-For` 为真实客户端 IP，客户端无法伪造来源绕过限流。

### 6.2 认证与会话
- 登录为常数时间 Token 比对（`crypto.timingSafeEqual`），防止时序侧信道。
- 会话 Cookie：`HttpOnly + Secure + SameSite=Lax + Path=/`，退出登录 `Max-Age=0`。
- 登录按 IP 限流（默认 10 次/15 分钟，超限封禁 15 分钟，返回 429 + `Retry-After`）。
- Token 永不写进任何 HTML/JS/日志；日志只记录 IP 与路由。

### 6.3 CSRF 防护（`originAllowed`，server.mjs）
对 `POST /login`、`POST /logout` 校验来源：
- 无 `Origin`（curl 等非浏览器）→ 放行；
- `Origin` 为具体源 → 仅比较 **hostname**（不比较端口）：浏览器在地址栏带
  `:443` 时 `Origin` 含端口，而 nginx `proxy_set_header Host $host` 会剥掉端口，
  两者都代表同一来源；
- `Origin: null`（隐私模式 / 严格 `referrer-policy` 下的表单提交）→ 回退校验
  `Referer` 的 hostname，同源才放行；跨站攻击者无法伪造一致的 Referer。
  登录页因此使用 `referrer-policy: strict-origin-when-cross-origin`
  （同源表单保留 Referer，跨站仍被剥掉）。

### 6.4 上游信任围栏（proxy.mjs）
网关对代理到 Harness 的请求：
- 重写 `Host: 127.0.0.1:3080`（覆盖客户端传入的 `Host`，nginx 传什么都不影响）；
- 剥离 `Origin / Cookie / Authorization`（会话只认网关自己的 Cookie）；
- 保留 WebSocket 握手字段（`Sec-WebSocket-*`、`User-Agent`）并透传升级。

### 6.5 安全响应头
- 所有响应：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Cross-Origin-Opener-Policy: same-origin`、CSP、`Referrer-Policy`。
- 登录页额外使用**严格 CSP**（`script-src 'self'`，无 inline script），
  `cache-control: no-store`。
- 代理页面的 CSP 在 `script-src` 中包含 `'unsafe-eval'`：Harness 前端 bundle
  （Cordis / schemastery 运行时）依赖 `new Function`，缺失会白屏。该放宽只作用于
  已认证的代理响应，登录页不受影响。

## 七、运维

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

> 注意：unit 文件里的 `WorkingDirectory`/`ExecStart` 指向 `/root/app/deepseek`，
> 请按实际检出位置修改；`dsh-auth-gateway.service` 的 `EnvironmentFile` 指向
> `deploy/.env`。

### Docker Compose（可选）

网关 + nginx 容器化（需宿主机 80/443 空闲，且 Harness 保持宿主机原生运行）：

```bash
bash deploy/nginx/gen-cert.sh
docker compose -f deploy/docker-compose.yml up -d --build
```

## 八、安全测试

```bash
bash deploy/scripts/security-test.sh https://127.0.0.1
```

共 **31 项**，覆盖：

- **未认证**：首页 302 跳登录、API 401、Cookie 无效/被删/被篡改均 401
- **认证**：正确 Token 登录 302、Cookie `HttpOnly/Secure/Path=/`、Token 不回显
- **授权**：登录后全路由（静态资源、`session.list`、特权 `settings.describe`）200
- **会话**：刷新保持、退出登录 302 + `Max-Age=0`
- **网络隔离**：公网 `IP:3080/3081` 拒绝连接、3080/3081 仅绑回环
- **WebSocket**：已登录 101 / 未登录 401；SSE 透传
- **防爆破**：同一 IP 第 11 次失败 → 429
- **响应头**：nosniff / X-Frame-Options / CSP / Referrer-Policy；登录页严格 CSP

## 九、常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录提交返回 `{"error":"forbidden"}` | 浏览器 `Origin` 与网关校验不一致（如带端口或 `null`） | 确认网关运行的是含 hostname-only + Referer 兜底的 `originAllowed`；刷新网关 |
| 登录后首页白屏 | 代理页 CSP 缺 `unsafe-eval`，Harness bundle 的 `new Function` 被拦 | `proxy.mjs` 的 `script-src` 必须含 `'unsafe-eval'`；强刷浏览器清缓存 |
| 登录成功但 API 返回 403 | 上游 `Host` 未被重写为回环，破坏 Harness 信任围栏 | `proxy.mjs` 的 `upstreamHeaders` 必须覆盖客户端 `Host` |
| 外网访问不通（502/超时） | 云安全组/EIP 未放行 80/443 | 在云控制台放行 `TCP 80,443` 并确认 EIP 转发 |
| 浏览器地址栏证书告警 | 自签名证书 SAN 不含访问的 IP | `PUBLIC_IP=<IP> bash deploy/nginx/gen-cert.sh` 后重装并 reload |
| 重启后所有会话失效 | `SESSION_SECRET` 未设置（每次随机） | 在 `.env` 固定 `SESSION_SECRET` |

## 十、安全注意事项

- 生产环境请替换为真实 CA 证书（Let's Encrypt / 云厂商），之后再启用 HSTS。
- **永远不要提交** `deploy/.env`、`deploy/.token`、`deploy/certs/`
  （已由 `.gitignore` 忽略）。
- `HARNESS_ACCESS_TOKEN` 与 `SESSION_SECRET` 建议分别用 `openssl rand -hex 32` 生成。
- Harness 上游版本升级后，先跑一遍 `security-test.sh` 再开放流量。

## License

部署与网关代码为示例/运维实现，可自由使用；DeepSeek Harness 遵循其上游许可证。