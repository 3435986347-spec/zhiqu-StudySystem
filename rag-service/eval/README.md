# RAG 质量评测

评测集使用 JSONL，每行直接包含 `/v1/query` 的请求字段，并额外包含 `expectedSourceIds`。正式验收至少覆盖 20 份资料和 60 个问题。

```json
{"requestId":"eval-1","userId":1,"notebookId":2,"question":"课程考试范围是什么？","candidateK":24,"sourceIds":[10,11],"indexVersion":"...","collectionName":"...","expectedSourceIds":[10]}
```

运行：

```powershell
python eval/evaluate.py eval/dataset.jsonl --token <sidecar token>
```

脚本会校验 `Recall@8 >= 0.85`、引用精度 `>= 0.90` 和暖机查询 `P95 <= 1.5s`。评测资料和问题可能包含私人内容，因此不提交到仓库。
