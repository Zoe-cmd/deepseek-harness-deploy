# DeepSeek Harness 部署说明（Auth Gateway）

浏览器 → Nginx(:443 HTTPS) → Auth Gateway(127.0.0.1:3081) → Harness(127.0.0.1:3080)

Harness 本身只监听回环地址，永不暴露公网；Token 认证、会话 Cookie、限流、TLS 全部由独立网关承担。

## 目录结构

```
deploy/
├── auth-gateway/           认证网关（零依赖 Node ESM，仅用 node:http/crypto）
│   ├── Dockerfile          可选的容器镜像
│   ├── server.mjs          入口：路由 /login /logout /healthz + 反向代理(HTTP/WS)
│   ├── config.mjs          .env 加载与校验
│   ├── session.mjs         会话存储（HMAC 摘要、滑动过期、可选 IP 绑定）
│   ├── auth.mjs            常数时间 Token 比对 + 登录限流
│   ├── proxy.mjs           HTTP/WS 代理：Host 重写、请求头剥离、安全响应头
│   └── views.mjs           登录页/错误页（严格 CSP）
├── nginx/
│   ├── nginx-gateway.conf         生产站点（安装到系统 nginx）
│   ├── nginx-gateway-docker.conf  Docker Compose 用独立 nginx
│   └── gen-cert.sh                自签名证书生成
├── scripts/
│   ├── start.sh | stop.sh | restart.sh | status.sh | logs.sh
│   └── security-test.sh           31 项功能+安全测试矩阵
├── docker-compose.yml      （可选）网关+nginx 容器化；Harness 保持宿主机原生运行
├── systemd/               dsh-harness.service / dsh-auth-gateway.service
├── .env.example           配置模板（复制为 .env 后填写）
├── .env                   实际配置（已 gitignore，勿提交）
└── .token                 Harness 访问令牌备份（已 gitignore）
```

## 配置（deploy/.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS_ACCESS_TOKEN` | （必填） | 访问令牌，缺失则启动失败（fail-fast） |
| `SESSION_SECRET` | 随机生成 | 会话 ID 的 HMAC 密钥；未设置则每次启动随机 |
| `SESSION_EXPIRE_SECONDS` | `86400` | 会话空闲过期（最短 5 秒，便于测试） |
| `SESSION_MAX_LIFETIME_SECONDS` | `604800` | 会话绝对最大寿命 |
| `SESSION_SLIDING` | `1` | 1=滑动过期 |
| `SESSION_BIND_IP` | `0` | 1=会话绑定来源 IP |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3081` | 网关监听地址（仅回环） |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `3080` | Harness 上游地址 |
| `COOKIE_SECURE` | `1` | Cookie 仅 HTTPS |
| `RATE_LIMIT_MAX` / `_WINDOW_MS` / `_BAN_MS` | `10` / `900000` / `900000` | 登录失败限流 |
| `TRUST_PROXY` | `1` | 信任 nginx 设置的 X-Forwarded-For |
| `SESSION_COOKIE_NAME` | `dsh_session` | 会话 Cookie 名 |

## 启动与运维

```bash
# 一键启动整栈（Harness + 网关）
bash deploy/scripts/start.sh
bash deploy/scripts/status.sh        # 各进程与端口状态
bash deploy/scripts/logs.sh          # 实时日志
bash deploy/scripts/restart.sh
bash deploy/scripts/stop.sh          # 停机

# 安全测试（31 项）
bash deploy/scripts/security-test.sh https://127.0.0.1

# systemd（可选，替代脚本）
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dsh-harness dsh-auth-gateway

# Docker Compose（可选，网关+nginx 容器化；需宿主机 80/443 空闲且 Harness 已原生启动）
bash deploy/nginx/gen-cert.sh
docker compose -f deploy/docker-compose.yml up -d --build
```

## 安全要点

- Harness 仅监听 `127.0.0.1:3080`，公网 `IP:3080` / `IP:3081` 直接拒绝连接。
- nginx 覆盖 `X-Forwarded-For` 为真实客户端 IP，客户端无法伪造来源绕过限流。
- 网关代理时重写 `Host: 127.0.0.1:3080` 并剥离 `Origin/Cookie/Authorization`，满足 Harness 的浏览器信任围栏，所有 API（含管理类）可用，无需 `--trusted-host`。
- Cookie 为 `HttpOnly + Secure + SameSite=Lax`；退出登录返回 `Max-Age=0`。
- 登录失败按 IP 限流（默认 10 次/15 分钟，超限封禁 15 分钟）。
- 日志不记录令牌、会话密钥或会话 ID。

## 上线后的关键修复（v2）

以下修复已在当前线上实例验证：

1. **CSRF 校验按 hostname 比较（server.mjs `originAllowed`）**：浏览器在地址栏带
   `:443` 时 `Origin` 含端口，而 nginx `proxy_set_header Host $host` 剥掉端口。
   改为只比较 hostname，登录不再误报 `forbidden`。
2. **`Origin: null` 回退 Referer 校验**：隐私模式 / 严格 referrer-policy 下的表单
   提交会发 `Origin: null`；此时回退校验 `Referer` hostname 同源才放行。登录页
   `referrer-policy` 相应改为 `strict-origin-when-cross-origin`。
3. **上游 `Host` 强制重写（proxy.mjs `upstreamHeaders`）**：客户端传入的 `Host`
   头不再覆盖重写后的 `127.0.0.1:3080`，否则 Harness 的 loopback 信任围栏会拒绝
   特权 API（登录成功但 `session.list` 等返回 403 `forbidden`）。
4. **代理页 CSP 增加 `'unsafe-eval'`**：Harness 前端 bundle 依赖 `new Function`，
   缺失会导致登录后白屏。登录页仍为严格 CSP（`script-src 'self'`）。
5. **测试 nginx 配置改为相对路径**（配合 `nginx -p deploy -c ...`），不再硬编码
   旧部署目录 `/root/test/test`。

## 已修复的已知问题

- 登录提交 403 `forbidden` → CSRF 端口/hostname 误判（#1/#2）。
- 登录成功但页面白屏 → CSP 拦截 `new Function`（#4）。
- 登录成功但 API 403 → 上游 `Host` 被客户端覆盖（#3）。

## 测试结果

31 项功能+安全测试全部 PASS：未认证重定向/401、正确/错误/篡改/删除 Cookie、登录后全路由（含特权 API）、WS 升级 101 vs 401、暴力破解 429、安全响应头、登录页严格 CSP、SSE 透传、回环绑定与公网端口拒绝。

会话过期验证（临时网关 `SESSION_EXPIRE_SECONDS=5`）：登录 302 → 立即访问 200 → 6 秒后页面 302 跳登录、API 401。

SPA 启动验证：登录后首页引导清单中的 42 个前端资源（插件 bundle + assets + manifest）全部 200。