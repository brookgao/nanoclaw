# 组件隔离与模块所有权

> 组件间引用必须通过明确接口、跨模块操作必须有所有权约定

## 问题

- 模块 A 直接引用模块 B 的内部状态（b._internal_state），B 内部重构后 A 崩溃
- 多个模块都可以修改同一个资源（如 session 状态），不清楚谁是"所有者"
- task 隔离不足，不同 task 的 component_ref 互相干扰

## 所有权原则

每个资源必须有明确的所有者：谁创建（负责初始化）、谁销毁（负责清理）、谁可以修改（其他模块只能读或通过接口间接修改）。

```python
# 错误：直接访问内部状态
other_module._session_cache[id] = value

# 正确：通过接口访问
other_module.update_session(id, value)
```

## task 隔离

每个 task 的 component_ref（前端组件引用）必须限定在 task 范围内。不同 task 之间的 component_ref 不能共享，否则一个 task 的 UI 操作影响另一个 task。

## 教训

- 模块之间禁止直接引用内部状态，必须通过公开接口（API/事件）
- 模块所有权要明确：谁负责创建、谁负责销毁、谁可以修改
- 跨模块调用必须有明确的合约（类型定义/接口规范）

## Related
- [cross-layer-development](cross-layer-development.md)
