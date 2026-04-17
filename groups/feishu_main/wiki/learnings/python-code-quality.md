# Python 代码质量陷阱

> 条件导入 UnboundLocalError、内联后死代码、async in sync 节点、all([]) 空列表陷阱

## 陷阱一：条件导入导致 UnboundLocalError

```python
# 错误：条件为 False 时，x 是 UnboundLocal
if condition:
    import module as x
result = x.do_something()  # NameError

# 正确
x = None
if condition:
    import module as x
if x:
    result = x.do_something()
```

## 陷阱二：内联后死代码未清理

内联函数后，原函数定义必须立即删除。死代码遮蔽新逻辑，特别是同名函数，Python 会用最后定义的版本。

## 陷阱三：sync 节点中调 async 函数

```python
# 错误：sync 函数中直接 await
def sync_node(state):
    result = await async_func()  # SyntaxError

# 正确：使用 asyncio.run
def sync_node(state):
    result = asyncio.run(async_func())
```

注意：如果当前已有事件循环，asyncio.run() 会报错，需用 loop.run_until_complete()。

## 陷阱四：all([]) == True

```python
# 错误：空列表被认为"全部通过"
all_pass = all(s.get("pass") for s in scenarios)  # scenarios=[] → True

# 正确：先检查非空
all_pass = all(s.get("pass") for s in scenarios) if scenarios else False
```

## 教训

- 条件导入的变量，在条件外使用前必须有默认值
- 内联函数后，立即删除原函数定义
- sync 节点中调 async，必须用 asyncio.run()
- all() 用于 pass/fail 判断时，必须先检查列表非空

## Related
- [vm-verify](vm-verify.md)
- [error-handling-shared-layer](error-handling-shared-layer.md)
