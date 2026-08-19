# DeepSeek Harness 安全部署（Auth Gateway）

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 部署在
**认证网关 + TLS 反向代理**之后，Harness 自身只监听回环地址、永不暴露公网。

```
浏览器 → Nginx(:443 HTTPS) → Auth Gateway(127.0.0.1:3081) → Harness(127.0.0.1:3080)
```

- **Harness**：官方 `@deepseek-ai/dsh`，仅监听 `127.0.0.1:3080`。
- **Auth Gateway**：独立零依赖 Node ESM 进程，实现 Token 认证、会话 Cookie、
  登录限流、HTTP/WebSocket 反向代理。
- **Nginx**：唯一公网入口（TLS :443 / HTTP :80 → 301），代理到网关。
- 网关代理时重写 `Host` 并剥离 `Origin/Cookie/Authorization`，满足 Harness 的
  浏览器信任围栏，全部 API（含管理/凭证/目录选择）可用，无需 `--trusted-host`；
  WebSocket（`/api/events.*`）与 SSE 正常透传。

## 特性

- Token 认证：登录后颁发 `HttpOnly + Secure + SameSite=Lax` 会话 Cookie，常数时间比对
- 会话管理：空闲过期、滑动续期、绝对最大寿命、可选 IP 绑定
- 防暴力破解：按 IP 限流（默认 10 次失败 / 15 分钟，超限封禁 15 分钟）
- TLS 终止于 nginx；登录页严格 CSP；安全响应头；日志不含任何密钥/令牌
- 31 项功能+安全自动化测试；可选 systemd 与 Docker Compose 部署

## 目录结构

```
├── deploy/
│   ├── auth-gateway/         认证网关源码（零依赖，仅 node:http/crypto）
│   ├── nginx/                nginx 站点配置（生产 / Docker / 测试）+ 证书脚本
│   ├── scripts/              运维脚本 + 安全测试矩阵
│   ├── systemd/              可选 systemd 单元
│   ├── docker-compose.yml    可选容器化（网关+nginx）
│   ├── .env.example          配置模板（复制为 .env 并填写）
│   └── README.md             部署运维说明
└── .gitignore
```

## 快速开始

前置要求：`node >= 18`（开发机为 node 22）、已安装 `@deepseek-ai/dsh` 并可通过
`node node_modules/@deepseek-ai/dsh/lib/bin.js web` 启动、可用的 Access Token。

```bash
# 1. 配置
cp deploy/.env.example deploy/.env
#    编辑 deploy/.env 填写 HARNESS_ACCESS_TOKEN（必填）、SESSION_SECRET 等
#    建议：openssl rand -hex 32

# 2. 生成证书并安装 nginx 站点（生产环境）
bash deploy/nginx/gen-cert.sh
sudo cp deploy/nginx/nginx-gateway.conf /etc/nginx/conf.d/harness-gateway.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. 启动整栈
bash deploy/scripts/start.sh

# 4. 验证
bash deploy/scripts/status.sh
bash deploy/scripts/security-test.sh https://127.0.0.1
```

## 配置说明（deploy/.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS_ACCESS_TOKEN` | 必填 | 访问令牌，缺失则网关启动失败（fail-fast） |
| `SESSION_SECRET` | 随机 | 会话 ID 的 HMAC 密钥 |
| `SESSION_EXPIRE_SECONDS` | `86400` | 会话空闲过期（最短 5 秒，便于测试） |
| `SESSION_MAX_LIFETIME_SECONDS` | `604800` | 会话绝对最大寿命 |
| `SESSION_SLIDING` | `1` | 滑动续期开关 |
| `SESSION_BIND_IP` | `0` | 会话绑定来源 IP |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3081` | 网关监听（仅回环） |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `3080` | Harness 上游（仅回环） |
| `COOKIE_SECURE` | `1` | Cookie 仅 HTTPS |
| `RATE_LIMIT_*` | `10 / 900000 / 900000` | 登录失败限流与封禁 |
| `TRUST_PROXY` | `1` | 信任 nginx 的 X-Forwarded-For |
| `SESSION_COOKIE_NAME` | `dsh_session` | 会话 Cookie 名 |

## 运维

```bash
bash deploy/scripts/start.sh        # 一键启动（Harness + 网关）
bash deploy/scripts/status.sh       # 进程与端口状态
bash deploy/scripts/logs.sh         # 实时日志
bash deploy/scripts/restart.sh
bash deploy/scripts/stop.sh

# 可选：systemd
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now dsh-harness dsh-auth-gateway

# 可选：Docker Compose（网关+nginx 容器化，需宿主机 80/443 空闲且 Harness 原生启动）
bash deploy/nginx/gen-cert.sh
docker compose -f deploy/docker-compose.yml up -d --build
```

## 安全测试

`bash deploy/scripts/security-test.sh https://127.0.0.1` 共 31 项，全部通过：

- 未认证：首页 302 跳登录、API 401
- 认证：正确 Token 登录、Cookie 标志、Token 不回显、错误/删除/篡改 Cookie 均 401
- 授权：登录后全路由（静态资源、`session.list`、特权 `settings.describe`）200
- 会话：刷新保持、退出登录清 Cookie（`Max-Age=0`）
- 网络隔离：公网 `IP:3080/3081` 拒绝连接、仅回环绑定
- WebSocket：已登录 101 / 未登录 401；SSE 透传
- 防爆破：第 11 次失败 → 429
- 响应头：nosniff / X-Frame-Options / CSP / Referrer-Policy；登录页严格 CSP

## 安全注意事项

- 生产环境请替换为真实 CA 证书（当前为自签名），再启用 HSTS。
- 永远不要提交 `deploy/.env`、`deploy/.token`、`deploy/certs/`（已被 .gitignore 忽略）。
- `HARNESS_ACCESS_TOKEN` 与 `SESSION_SECRET` 建议分别用 `openssl rand -hex 32` 生成。

## License

部署与网关代码为示例/运维实现，可自由使用；DeepSeek Harness 遵循其上游许可证。