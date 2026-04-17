# Protobuf / protoc 编译与兼容性问题

> protoc 版本兼容、include 路径、zsh 分词、pb.go 污染等一系列 Protobuf 问题

## 问题

- **版本不兼容（PR #614）**：protoc 版本与 protoc-gen-go 插件版本不匹配，生成的 .pb.go 有 API 差异
- **include 路径错误**：protoc -I 路径不含 google/protobuf 目录，import "google/protobuf/timestamp.proto" 找不到
- **zsh 分词**：在 zsh shell 中 $PROTO_FILES 不按空格分词，protoc 收到整个字符串而非文件列表
- **pb.go 污染**：旧的 .pb.go 文件未清理，重新生成后新旧文件共存，编译器同名符号冲突
- **go_package 路径**：proto 文件中 option go_package 路径与实际模块路径不一致
- **RPC include**：service 定义的 proto 文件未 import 所有用到的 message proto，部分符号解析失败

## 根因

protoc 生成链路：proto 文件 → protoc + 插件 → .pb.go → Go 编译器，任何一环版本或路径不对都会失败，且报错通常指向下游而非根因。

## 修复

- **PR #614**：锁定 protoc 版本 + 插件版本，写入 Makefile
- include 路径：protoc -I/usr/local/include -I.，确保 google/protobuf well-known types 可解析
- zsh 分词：改用 while read f; do protoc ... "$f"; done <<< "$PROTO_FILES"
- 全量重新生成：find . -name '*.pb.go' -delete && make proto
- go_package：option go_package = "github.com/org/repo/pkg/proto;proto" 与 go.mod module 路径对齐
- RPC include：service proto 必须 import 所有用到的 message proto 文件

## 教训

- protoc + 插件版本必须锁定，写入版本文件或 Makefile，不能依赖系统全局安装
- 全量重新生成前先删除所有旧 .pb.go，避免污染
- 在 zsh 环境运行 protoc 脚本时，变量展开方式与 bash 不同，必须显式处理分词
- 新增 RPC 时，import 列表要包含所有用到的 message proto

## Related
- [go-build-deploy](go-build-deploy.md)
