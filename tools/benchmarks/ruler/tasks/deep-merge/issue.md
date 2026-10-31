config.py 的 deep_merge 有几个问题：
- 嵌套的 dict 要递归合并（现在整个被覆盖）：`deep_merge({'db': {'host': 'a', 'port': 1}}, {'db': {'port': 2}})` → `{'db': {'host': 'a', 'port': 2}}`
- list 不合并，直接用 override 里的
- override 里值为 `None` 的键表示删掉这个键（嵌套里也一样）
- 不能改动传进来的两个 dict；返回的结果也不能和它们共用嵌套的对象（调用方以后改结果，不能改到原来的配置）
