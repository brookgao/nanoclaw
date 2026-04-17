# Go 构建 / Sandbox / Monorepo 问题

> Go sandbox 启动失败的多层洋葱根因、sumdb 死锁、cross-repo replace、编译超时等

## 问题

**Sandbox 启动五层洋葱**：Go sandbox 启动失败，表现为健康检查未通过，实际根因层层嵌套：
1. 应用代码 panic
2. 依赖库版本冲突
3. replace 路径错误
4. sumdb 网络死锁
5. cgo 依赖 .so 缺失（libdl.so.2）

**sumdb 死锁**：Go toolchain 在网络受限环境中访问 sum.golang.org 超时，导致 go mod download 永久阻塞。

**cross-repo replace 路径**：monorepo 使用 go work + replace 指令，但跨仓库 replace 路径在 worktree 环境中相对路径解析错误。

**编译超时设置错误**：ai_timeout（AI 响应超时）被误用为编译超时，Go 项目编译需要更长时间（推荐 600s）。

**Golang 方法幻觉**：LLM 生成的 Go 代码调用了不存在的 interface 方法，编译失败，LLM 不承认而继续幻觉。

**go work MVS 风险**：go work 的最小版本选择（MVS）有时选到不兼容版本，且不报 conflict。

## 根因

- Go 依赖链错误的报错往往在最终层，需要一层一层剥才能找到根因
- sumdb 在受限网络中没有超时机制，会永久阻塞
- 相对路径 replace 在 worktree（非标准目录结构）中解析失败

## 修复

- **sumdb**：设置 GONOSUMCHECK=* 或 GONOSUMDB=* + GOFLAGS=-mod=mod，跳过 sumdb 验证
- **cross-repo replace**：使用绝对路径或在 go.work 中统一管理 replace
- **编译超时**：单独设置 BUILD_TIMEOUT（建议 600s），不复用 ai_timeout
- **CGO**：所有服务端 Go 二进制使用 CGO_ENABLED=0，消除 .so 依赖

## 教训

- Go sandbox 启动失败必须从最底层开始排查，不要停在第一个错误
- go work + MVS 有版本冲突风险，新增依赖后必须运行 go mod tidy 并 review go.sum 变更
- 网络受限环境中，所有外网请求必须有超时配置，Go sumdb 尤其危险
- 编译超时和 AI 超时是两个不同的量级，不能共用同一个配置项
- CGO_ENABLED=0 是生产环境 Go 二进制的标准配置

## Related
- [vm-verify](vm-verify.md)
- [protobuf-protoc](protobuf-protoc.md)
