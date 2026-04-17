# 错误处理：在共享层捕获

> 错误应在最近的共享层捕获并处理，不要在每个调用点重复处理

## 问题

多个 agent 节点各自有 try-catch，但处理逻辑不一致（有的记录日志，有的静默忽略，有的重新抛出），导致错误处理行为难以预测。

## 修复规范

错误处理应在离用户最近的共享层（middleware/decorator/base class）统一实现：

```python
# 正确：在共享层捕获
class BaseNode:
    def run(self, state):
        try:
            return self._run(state)
        except Exception as e:
            logger.error(f"Node {self.name} failed: {e}")
            emit_error_event(e)
            raise

# 错误：各调用点各自处理，逻辑不一致
def my_node(state):
    try:
        ...
    except Exception as e:
        print(e)  # 各自处理，不统一
```

## 教训

- 错误处理策略必须在共享层（middleware/decorator）统一实现
- 各调用点只做"是否需要特殊处理"的判断，不做通用错误处理
- 日志记录、错误上报、用户通知等都应在共享层完成
- 静默吞异常是最危险的行为，必须至少记录日志

## Related
- [debugging-methodology](debugging-methodology.md)
- [systemic-defects](systemic-defects.md)
