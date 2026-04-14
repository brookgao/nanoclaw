# Feishu Open Platform — Setup for NanoClaw

## 1. Create the app

1. Go to https://open.feishu.cn/app
2. 点击「创建企业自建应用」
3. 应用名称: e.g. "Andy Assistant"; 描述随意; 头像可选
4. 创建完成后，进入应用详情页

## 2. Enable bot capability

1. 左侧 →「添加应用能力」
2. 找到「机器人」→ 点击「添加」
3. 填写机器人描述与欢迎语

## 3. Event subscription (long-connection mode)

1. 左侧 →「事件与回调」→「事件配置」
2. 订阅方式: **「长连接」**（推荐；无需公网地址）
3. 点击「添加事件」→ 搜索并勾选:
   - `im.message.receive_v1`（接收消息）

## 4. Permissions

左侧 →「权限管理」→ 搜索并开启:

| scope | 用途 |
|---|---|
| `im:message` | 获取消息基础 |
| `im:message.group_at_msg` | 群里接收 @机器人 |
| `im:message.p2p_msg` | 接收单聊消息 |
| `im:chat` | 读取会话信息（群名等） |
| `im:message:send_as_bot` | 以机器人身份发送消息 |

## 5. Version / publish

1. 左侧 →「版本管理与发布」→「创建版本」
2. 版本号（如 `1.0.0`）、更新说明
3. 提交，**等租户管理员审批通过**

## 6. Get credentials

左侧 →「凭证与基础信息」

- **App ID** (形如 `cli_xxxxxxxxxxxx`) → 填入 `FEISHU_APP_ID`
- **App Secret** → 填入 `FEISHU_APP_SECRET`

**注意安全**: 不要把 `.env` 提交到 git。`chmod 600 .env` 收紧权限。Secret 泄露后到凭证页面重置。

## 7. Add bot to chats

- **私聊**: 飞书 app 内搜索应用名称，打开会话
- **群聊**: 群设置 → 群机器人 → 添加 → 选择你的应用

## Troubleshooting

- **机器人不回消息**: 检查 `[feishu] WS connected` 日志；版本是否已审批；权限改动后要**发新版本**才生效。
- **群里 @机器人 无响应**: 确认 `im:message.group_at_msg` 已授权；消息里真包含 @机器人（而不是 @某人）。
- **401 / invalid app**: `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 拼写错误，或 `FEISHU_DOMAIN` 不小心填成了 `lark`。
- **机器人自说自话**: 不该发生——channel 已过滤 `sender_type=app` 和 `open_id=botOpenId`。若仍出现，看 botOpenId 是否解析成功（`[feishu] bot info resolved`）。
