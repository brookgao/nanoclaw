# VM 验收与 Sandbox 健康检查

> VM 验收 0/0、infra_error、recursion limit、健康检查死循环等问题合集

## 问题

**0/0 验收（PR #763）**：编译失败后验收显示 0/0 scenarios 通过，根因：Python all([]) == True 陷阱 + 编译失败静默跳过。

**alpine-go libdl 缺失**：所有 Go 项目验收 infra_error，根因是 alpine-go rootfs gcompat 未创建 libdl.so.2 symlink。

**recursion limit**：vm_verify_execute 中某递归路径未设上限，特定输入触发 Python 默认 1000 层栈溢出。

**健康检查死循环**：verify_health_check 在服务未启动时进入死循环，无超时保护。

**PyMySQL not connected**：DB 连接在验收 worker 中提前关闭，后续查询报 not connected。

**员工匹配（PR #691）**：员工匹配逻辑用拼音首字母模糊匹配，多人重名时返回错误用户。

**guide 截断（PR #884）**：verify prompt 中 guide 超长时被截断，LLM 失去上下文，验收判断错误。

**sandbox ws_url 为空**：sandbox_registry 返回的 ws_url 为空字符串（falsy），websocket 连接失败。

**crash awareness（PR #655）**：sandbox 进程崩溃后 registry 未感知，仍返回 healthy，验收假通过。

## 根因

- all([]) == True：Python 空列表的"全部通过"语义陷阱
- alpine rootfs 构建脚本遗漏 gcompat symlink 列表中的 libdl.so.2
- 健康检查无超时 = 永久阻塞
- sandbox_registry ws_url 字段，0/None/"" 均为 falsy，需显式判断

## 修复

- **PR #763**：all(s.get("pass") for s in items) if items else False；编译失败抛出异常
- **libdl 修复**：ln -s libgcompat.so.0 libdl.so.2；Go 编译加 CGO_ENABLED=0
- **健康检查**：加 timeout 参数（默认 60s），超时返回 False
- **crash awareness（PR #655）**：sandbox 进程退出时主动通知 registry 更新状态
- **员工匹配（PR #691）**：改为精确匹配 + 工号匹配，不用拼音模糊

## 排查方法

```bash
# 查验收阶段最后事件
redis-cli ZRANGE events:{SID} -15 -1
# 查 sandbox-api 日志
ssh heasenbug@10.117.0.159 "journalctl -u sandbox-api --tail 50"
# 挂载 rootfs 检查依赖
readelf -d /path/to/binary | grep NEEDED
```

## 教训

- all() 用于 pass/fail 判断时，必须先检查列表非空：all(items) if items else False
- alpine Go rootfs 重建时，必须确认 gcompat 所有 symlink 齐全（包括 libdl.so.2）
- Go 二进制编译必须用 CGO_ENABLED=0，产静态二进制
- 健康检查必须有超时保护，无超时 = 潜在死循环

## Related
- [git-deploy](git-deploy.md)
- [go-build-deploy](go-build-deploy.md)
- [sso-sandbox-browser](sso-sandbox-browser.md)
