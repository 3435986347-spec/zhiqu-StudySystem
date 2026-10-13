#!/usr/bin/env python3
"""Build reports for the full v2/v3 HumanEval + DeepSeek-v4-pro protocol.

Requires 164 tasks, one episode per task, a 1M context window, 20 agent rounds,
300 seconds, two workers and 50 requests/min. Other protocols/models/subsets are
rejected rather than silently inheriting this run's score or fixed model prices.

Reads the final manifest, score report, per-task generation metadata, public
task prompts, and final solution bytes for protocol-error review. Does not call
a model, execute candidates or read the private official dataset. Refuses
incomplete or inconsistent run artifacts.
"""

import argparse
import collections
import csv
import datetime
import hashlib
import html
import json
import math
from pathlib import Path
import re
import statistics
import sys


EXPECTED_IDS = {"HumanEval/%d" % number for number in range(164)}
PRICE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
SOURCES = {
    "HumanEval": "https://github.com/openai/human-eval",
    "officialChecker": "https://github.com/openai/human-eval/blob/6d43fb980f9fee3c892a914eda09951f772ad10d/human_eval/execution.py",
    "DeepSeekPricing": PRICE_URL,
}
PRICES = {"currency": "CNY", "unit": "per 1000000 tokens", "input_cache_miss_peak": 9.0,
          "input_cache_hit_peak": 0.3, "output_peak": 27.0, "offpeak_multiplier": 0.5,
          "cache_breakdown": "unknown", "source": PRICE_URL}
HISTORICAL_ADAPTER_SHA256 = "9f02aa25d48a040ba7429b80f30ebfde0f7ac3bbbe50ecc8044cbbfd2f595eae"
HISTORICAL_FINGERPRINT = "e19cde42d2c0387c2c4fb2c5e1dc32bf86c2bc05126ad8aeba21415aa859bc78"
HISTORICAL_NOTE = (
    "95.12% 是 2026-10-13 评测后防御修复之前的冻结 v2 历史结果。当前可运行工具已更新到 v3 并追加评测后防御修复，"
    "没有调用模型重新跑、修改候选或改分；原始 manifest、score 与证据指纹保持不变。"
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def task_number(task_id):
    return int(task_id.split("/")[1])


def integer(value, name):
    require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, "Invalid nonnegative integer: " + name)
    return value


def parse_time(text):
    value = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    require(value.tzinfo is not None, "Run timestamps must include a timezone")
    return value


def local_time(text):
    return parse_time(text).astimezone(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S CST")


def distribution(values):
    if not values:
        return {"count": 0, "total": 0, "mean": None, "median": None, "p95": None, "min": None, "max": None}
    ordered = sorted(values)
    # Nearest-rank percentile: reproducible and appropriate for this small sample.
    return {"count": len(values), "total": sum(values), "mean": statistics.mean(values),
            "median": statistics.median(values), "p95": ordered[math.ceil(0.95 * len(ordered)) - 1],
            "min": ordered[0], "max": ordered[-1], "p95_method": "nearest-rank"}


def cost_range(prompt_tokens, completion_tokens):
    low = (prompt_tokens * PRICES["input_cache_hit_peak"] + completion_tokens * PRICES["output_peak"]) / 1000000
    high = (prompt_tokens * PRICES["input_cache_miss_peak"] + completion_tokens * PRICES["output_peak"]) / 1000000
    return {"peak_cny": {"low_all_input_cache_hit": low, "high_all_input_cache_miss": high},
            "offpeak_cny": {"low_all_input_cache_hit": low * 0.5, "high_all_input_cache_miss": high * 0.5},
            "is_actual_bill": False, "cache_breakdown_known": False}


def review_protocol_error(public, generation, result_path):
    expected = public["prompt"].encode("utf-8")
    solution = result_path.parent / "workspace" / "solution.py"
    require(not solution.is_symlink(), "Final solution artifact must not be a symlink: " + public["task_id"])
    actual = solution.read_bytes() if solution.is_file() else None
    if actual is not None:
        require(sha(actual) == generation.get("solution_sha256"), "Protocol-error final solution hash differs: " + public["task_id"])
    else:
        require(generation.get("solution_sha256") is None, "Recorded final solution artifact is missing: " + public["task_id"])
    prefix_changed = actual is not None and not actual.startswith(expected)
    difference = (next((index for index, (left, right) in enumerate(zip(expected, actual)) if left != right), min(len(expected), len(actual)))
                  if prefix_changed else None)
    removed_leading_blank_line = prefix_changed and expected.startswith(b"\n") and actual.startswith(expected[1:])
    implementation_missing = actual is None or (not prefix_changed and not actual[len(expected):].strip())
    error = str(generation.get("error", "")).lower()
    if removed_leading_blank_line:
        kind = "one_leading_blank_line_removed"
        note = "删除了一个开头换行（first_difference_byte=%d），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。" % difference
    elif prefix_changed:
        kind = "other_prompt_prefix_change"
        note = "公开 prompt 的精确前缀被改动（first_difference_byte=%d）；未进行任何修复或重试，不能单凭协议失败判定算法是否正确。" % difference
    elif "model" in error and "start" in error:
        kind = "missing_actual_model_evidence"
        note = "缺少经核对的实际模型 start 事件证据，未证明请求由所选模型处理；这是流协议失败，文件前缀未改动。"
        if implementation_missing:
            note += "最终文件也没有提交实现。"
    elif actual is None:
        kind = "missing_solution"
        note = "没有最终 solution.py，未形成可评分的实现；这是生成协议失败，不是文件前缀变化。"
    elif implementation_missing:
        kind = "missing_implementation"
        note = "原始 prompt 前缀保留，但没有提交实现；这是生成协议失败，不是前缀变化。"
    else:
        kind = "other_protocol_error"
        note = "原始 prompt 前缀保留，生成阶段发生其他协议错误；不按前缀修改或官方测试失败分类。"
    return {"task_id": public["task_id"], "function": public["entry_point"], "reviewed": True,
            "first_difference_byte": difference, "kind": kind, "only_leading_blank_line_removed": removed_leading_blank_line,
            "prefix_changed": prefix_changed, "implementation_missing": implementation_missing,
            "expected_prompt_sha256": sha(expected), "actual_solution_sha256": sha(actual) if actual is not None else None, "note": note}


def verify_run(root):
    manifest = read_json(root / "manifest.json")
    score = read_json(root / "score.json")
    require(manifest.get("finished_at"), "Generation is incomplete: manifest.finished_at absent")
    require(manifest.get("version") in (2, 3), "This report builder supports protocol v2/v3 only")
    require(manifest.get("version") != 3 or manifest.get("source", {}).get("adapter_sha256") != HISTORICAL_ADAPTER_SHA256,
            "Protocol v3 cannot reuse the frozen historical v2 adapter fingerprint")
    require(score.get("status") == "scored", "Official scoring did not finish successfully")
    require(manifest.get("official_tasks") == 164 and manifest.get("tasks") == 164 and manifest.get("subset") is False,
            "This builder requires the complete 164-task HumanEval run")
    require(manifest.get("samples_per_task") == 1 and score.get("denominator") == 164,
            "Protocol must have one episode per task and a fixed 164 denominator")
    require(manifest.get("dataset_sha256") == score.get("sourceSha256"), "Dataset source hashes differ")
    require(manifest.get("max_rounds") == 20 and manifest.get("timeout_seconds") == 300
            and manifest.get("concurrency") == 2 and manifest.get("requests_per_minute") == 50,
            "Formal run limits differ from 20 rounds / 300s / 2 workers / 50 rpm")
    require(manifest.get("prompt_protocol") == "solution.py exact official prompt prefix; implementation appended; no hidden test feedback",
            "Unexpected generation protocol")
    model = manifest.get("model", {})
    require(model.get("modelName") == "deepseek-v4-pro" and model.get("effectiveContextWindow") == 1000000,
            "Unexpected model or effective context window")
    require(score.get("testTimeoutSeconds") == 3.0, "Official check timeout must remain 3 seconds")
    scored = score.get("results", [])
    require(len(scored) == 164 and {row.get("task_id") for row in scored} == EXPECTED_IDS,
            "Score must contain exactly one result for each HumanEval/0..163")
    score_by_id = {row["task_id"]: row for row in scored}
    rows = []
    paths_seen = set()
    request_ms = []
    tools = collections.Counter()
    all_requests = 0
    prompt_total = 0
    completion_total = 0
    estimated_tasks = 0
    missing_usage = 0
    provider_reported_requests = 0
    estimated_requests = 0
    unknown_usage_requests = 0
    protocol_reviews = []
    for result_path in sorted((root / "tasks").glob("*/result.json")):
        generation = read_json(result_path)
        task_id = generation.get("task_id")
        require(task_id in EXPECTED_IDS and task_id not in paths_seen, "Unknown or duplicate generation task: " + str(task_id))
        paths_seen.add(task_id)
        public = read_json(result_path.parent / "public-task.json")
        require(public.get("task_id") == task_id and isinstance(public.get("entry_point"), str)
                and isinstance(public.get("prompt"), str), "Invalid public task: " + task_id)
        require(sha(public["prompt"].encode("utf-8")) == generation.get("prompt_sha256"), "Public prompt hash differs: " + task_id)
        require(generation.get("fingerprint") == manifest.get("fingerprint"), "Per-task run fingerprint differs: " + task_id)
        actual_model = generation.get("model", {})
        require(actual_model.get("id") == model.get("id") and actual_model.get("modelName") == model.get("modelName"),
                "Generation used a different model: " + task_id)
        evaluated = score_by_id[task_id]
        require(generation.get("generation_status") == evaluated.get("generation_status"), "Generation/scoring status differs: " + task_id)
        if generation.get("solution_sha256"):
            require(generation["solution_sha256"] == evaluated.get("solution_sha256"), "Scored solution hash differs: " + task_id)
        generation_status = generation["generation_status"]
        require(isinstance(evaluated.get("passed"), bool), "Score verdict must be boolean: " + task_id)
        if evaluated["passed"]:
            require(generation_status == "completed" and evaluated.get("status") == "passed", "Invalid passing verdict: " + task_id)
        require(evaluated.get("status") not in ("verifier_error", "verifier_timeout", "missing_sample"),
                "Incomplete or infrastructure-failed scoring: " + task_id)
        usage = generation.get("usage", {})
        prompt = integer(usage.get("prompt_tokens", 0), task_id + " prompt_tokens")
        completion = integer(usage.get("completion_tokens", 0), task_id + " completion_tokens")
        count_requests = integer(generation.get("model_requests", 0), task_id + " model_requests")
        count_tools = integer(generation.get("tool_calls", 0), task_id + " tool_calls")
        rounds = integer(generation.get("rounds", 0), task_id + " rounds")
        duration = integer(generation.get("duration_ms", 0), task_id + " duration_ms")
        request_records = generation.get("requests", [])
        require(len(request_records) == count_requests, "Request-record count differs: " + task_id)
        for request in request_records:
            requested = request.get("actual_model")
            if requested:
                require(requested.get("id") == model.get("id") and requested.get("modelName") == model.get("modelName"),
                        "Request used another model: " + task_id)
            if isinstance(request.get("duration_ms"), (int, float)):
                request_ms.append(request["duration_ms"])
            request_usage = request.get("usage", {})
            if request_usage.get("estimated") is False:
                provider_reported_requests += 1
            elif request_usage.get("estimated") is True:
                estimated_requests += 1
            else:
                unknown_usage_requests += 1
        if all(isinstance(request.get("usage", {}).get("promptTokens"), int)
               and isinstance(request.get("usage", {}).get("completionTokens"), int) for request in request_records):
            require(sum(request["usage"]["promptTokens"] for request in request_records) == prompt
                    and sum(request["usage"]["completionTokens"] for request in request_records) == completion,
                    "Per-request and per-task usage totals differ: " + task_id)
        by_name = generation.get("tools_by_name", {})
        require(sum(by_name.values()) == count_tools, "Tool count differs: " + task_id)
        tools.update(by_name)
        require(rounds <= manifest["max_rounds"], "Task exceeded agent round budget: " + task_id)
        all_requests += count_requests
        prompt_total += prompt
        completion_total += completion
        estimated_tasks += bool(usage.get("estimated"))
        missing_usage += usage.get("missing_usage", 0)
        reason = generation.get("error") or evaluated.get("error") or evaluated.get("result") or ""
        if generation_status == "protocol_error":
            review = review_protocol_error(public, generation, result_path)
            protocol_reviews.append(review)
            reason += "；" + review["note"]
        elif generation_status == "round_limit":
            reason = "达到20轮上限，最后仍在工具调用，自建检查/参数修正未收尾。"
            if generation.get("error"):
                reason += "完整性备注：" + generation["error"]
                if "official prompt prefix" in generation["error"]:
                    integrity_review = review_protocol_error(public, generation, result_path)
                    reason += "；" + integrity_review["note"]
        elif evaluated.get("result") == "failed: ":
            reason = "官方断言未通过（检查器无额外错误文本）"
        if generation_status != "completed":
            failure_group = "generation"
        elif not evaluated["passed"]:
            failure_group = "checker"
        else:
            failure_group = "none"
        rows.append({"task_id": task_id, "function": public["entry_point"], "passed": evaluated["passed"],
                     "generation_status": generation_status, "primary_status": generation.get("primary_status") or generation_status,
                     "checker_status": evaluated["status"], "checker_result": evaluated.get("result"),
                     "failure_group": failure_group, "reason": reason, "duration_ms": duration,
                     "verification_duration_ms": evaluated.get("verificationDurationMs", 0),
                     "requests": count_requests, "rounds": rounds, "tools": count_tools,
                     "prompt_tokens": prompt, "completion_tokens": completion,
                     "tokens_estimated": bool(usage.get("estimated")), "transport_wait_ms": generation.get("transport_wait_ms", 0),
                     "solution_sha256": generation.get("solution_sha256")})
    require(paths_seen == EXPECTED_IDS, "Generation metadata is incomplete")
    rows.sort(key=lambda row: task_number(row["task_id"]))
    generation_counts = dict(collections.Counter(row["generation_status"] for row in rows))
    score_counts = dict(collections.Counter(row["checker_status"] for row in rows))
    passed = sum(row["passed"] for row in rows)
    require(generation_counts == manifest.get("generation_counts") == score.get("generationCounts"), "Generation counts differ across artifacts")
    require(score_counts == score.get("counts"), "Scoring counts differ")
    require(score.get("passed") == passed and score.get("failed") == 164 - passed
            and math.isclose(score.get("passRate", -1), passed / 164, abs_tol=1e-12), "Score arithmetic is inconsistent")
    require(manifest.get("model_requests") == all_requests, "Manifest model-request total differs")
    require(manifest.get("usage", {}).get("prompt_tokens") == prompt_total
            and manifest.get("usage", {}).get("completion_tokens") == completion_total, "Manifest token totals differ")
    elapsed = (parse_time(manifest["finished_at"]) - parse_time(manifest["started_at"])).total_seconds()
    require(elapsed >= 0, "Negative run elapsed time")
    return manifest, score, rows, {
        "generation_counts": generation_counts, "checker_counts": score_counts, "passed": passed,
        "failed": 164 - passed, "generation_failures": sum(row["failure_group"] == "generation" for row in rows),
        "protocol_failures": generation_counts.get("protocol_error", 0),
        "prefix_protocol_failures": sum(review["prefix_changed"] for review in protocol_reviews),
        "other_protocol_failures": sum(not review["prefix_changed"] for review in protocol_reviews),
        "other_protocol_kinds": dict(collections.Counter(review["kind"] for review in protocol_reviews if not review["prefix_changed"])),
        "protocol_reviews": sorted(protocol_reviews, key=lambda review: task_number(review["task_id"])),
        "checker_failures": sum(row["failure_group"] == "checker" for row in rows), "denominator": 164,
        "agent_episode_success_rate": passed / 164, "elapsed_seconds": elapsed,
        "task_duration_ms": distribution([row["duration_ms"] for row in rows]),
        "model_request_duration_ms": distribution(request_ms), "requests_per_task": distribution([row["requests"] for row in rows]),
        "tools_per_task": distribution([row["tools"] for row in rows]), "rounds_per_task": distribution([row["rounds"] for row in rows]),
        "prompt_tokens_per_task": distribution([row["prompt_tokens"] for row in rows]),
        "completion_tokens_per_task": distribution([row["completion_tokens"] for row in rows]),
        "model_requests": all_requests, "tool_calls": sum(row["tools"] for row in rows), "tools_by_name": dict(tools),
        "usage": {"prompt_tokens": prompt_total, "completion_tokens": completion_total,
                  "estimated": bool(estimated_tasks or estimated_requests or manifest.get("usage", {}).get("estimated")),
                  "tasks_with_estimates": estimated_tasks, "missing_usage_requests": missing_usage,
                  "provider_reported_requests": provider_reported_requests,
                  "estimated_requests": estimated_requests, "unknown_usage_requests": unknown_usage_requests},
        "cost_estimate": cost_range(prompt_total, completion_total),
    }


def pilot_at(path):
    if path is None:
        return None
    manifest = read_json(path / "manifest.json")
    require(manifest.get("finished_at"), "Pilot manifest is incomplete")
    require(manifest.get("model", {}).get("modelName") == "deepseek-v4-pro", "Pilot used another model; fixed pricing does not apply")
    usage = manifest.get("usage", {})
    prompt = integer(usage.get("prompt_tokens", 0), "pilot prompt_tokens")
    completion = integer(usage.get("completion_tokens", 0), "pilot completion_tokens")
    return {"path": str(path), "included_in_score": False, "purpose": "Initial transport/rate-limit pilot; no best-of selection",
            "started_at": manifest["started_at"], "finished_at": manifest["finished_at"],
            "generation_counts": manifest.get("generation_counts"), "model_requests": manifest.get("model_requests"),
            "usage": usage, "cost_estimate": cost_range(prompt, completion)}


def cost_stats_at(path, metrics):
    require(metrics.get("pilot") is not None, "--cost-stats requires --pilot-dir for formal-plus-calibration totals")
    receipt = read_json(path)
    require(receipt.get("source") == "user_provided_usage_statistics" and receipt.get("currency") == "CNY"
            and receipt.get("scope") == "formal_run_plus_initial_calibration", "Unsupported user cost-statistics source or scope")
    amount = receipt.get("amount")
    require(isinstance(amount, (int, float)) and not isinstance(amount, bool) and math.isfinite(amount) and amount >= 0,
            "Invalid user-provided cost amount")
    tokens = integer(receipt.get("tokens"), "user cost tokens")
    integer(receipt.get("api_requests"), "user cost API requests")
    total = metrics["combined_usage"]["prompt_tokens"] + metrics["combined_usage"]["completion_tokens"]
    require(tokens == total, "User-reported tokens do not match formal plus calibration records")
    receipt.update(recorded_total_tokens=total, token_total_matches_records=True,
                   independently_verified_bill=False, source_file=Path(path).name,
                   source_file_sha256=sha(Path(path).read_bytes()),
                   local_gateway_attempts=metrics["statistics"]["model_requests"] + metrics["pilot"]["model_requests"],
                   api_request_count_is_separate=True)
    return receipt


def num(value, decimals=0):
    return "n/a" if value is None else format(value, ",.%df" % decimals)


def money(value):
    return "¥" + format(value, ".2f")


def bounds(cost, peak=True):
    values = cost["peak_cny" if peak else "offpeak_cny"]
    return money(values["low_all_input_cache_hit"]) + "–" + money(values["high_all_input_cache_miss"])


def md_cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def markdown(metrics, root):
    s = metrics["statistics"]
    protocol = metrics["protocol"]
    source = metrics["source"]
    failed = [row for row in metrics["tasks"] if not row["passed"]]
    lines = ["# 知趣 CLI × DeepSeek-v4-pro · HumanEval 跑分", "",
             "**%d/164（%.2f%%）单次 agent episode 成功。**" % (s["passed"], s["agent_episode_success_rate"] * 100), "",
             "这是 HumanEval 的 164 道 Python 函数实现题，通过知趣原有 agent 循环读写文件并调用本地工具，最终由官方隐藏测试评分。"
             "它测量模型与知趣工具循环的组合，不能当作 SWE-bench 仓库修复成绩或纯模型 leaderboard 排名。", "",
             "- 生成成功 %d/164；生成或协议失败 %d 题；生成后未通过官方检查 %d 题。"
             % (s["generation_counts"].get("completed", 0), s["generation_failures"], s["checker_failures"]),
             "- 分母始终是 164，包含原始 prompt 前缀被改动的协议失败。每题一次 episode；没有隐藏测试反馈、重跑择优或 best-of 合并。",
             "- 协议失败单列：%d 题，其中前缀修改 %d 题，其他协议失败 %d 题。%s"
             % (s["protocol_failures"], s["prefix_protocol_failures"], s["other_protocol_failures"], metrics["protocol_review"]["note"]),
             "- 时间：%s 至 %s；总耗时 %.1f 分钟；单题中位数 %.2f 秒，p95 %.2f 秒（nearest-rank）。"
             % (local_time(protocol["started_at"]), local_time(protocol["finished_at"]), s["elapsed_seconds"] / 60,
                s["task_duration_ms"]["median"] / 1000, s["task_duration_ms"]["p95"] / 1000),
             "- 模型 `%s`，有效上下文 %s tokens；知趣 CLI commit `%s`（dirty=%s）。"
             % (metrics["model"]["modelName"], num(metrics["model"]["effectiveContextWindow"]), source["cli"]["commit"], source["cli"]["dirty"]),
             "- 单题最多 20 轮、300 秒；并发 2；每 worker 最小请求间隔 2.4 秒，目标合计不超过 50 requests/min；官方测试超时 3 秒。", "",
             "| 指标 | 合计 | 每题中位数 | 每题 p95 |", "|---|---:|---:|---:|",
             "| 模型请求 | %s | %s | %s |" % (num(s["model_requests"]), num(s["requests_per_task"]["median"], 1), num(s["requests_per_task"]["p95"])),
             "| 工具调用 | %s | %s | %s |" % (num(s["tool_calls"]), num(s["tools_per_task"]["median"], 1), num(s["tools_per_task"]["p95"])),
             "| 输入 tokens | %s | %s | %s |" % (num(s["usage"]["prompt_tokens"]), num(s["prompt_tokens_per_task"]["median"]), num(s["prompt_tokens_per_task"]["p95"])),
             "| 输出 tokens | %s | %s | %s |" % (num(s["usage"]["completion_tokens"]), num(s["completion_tokens_per_task"]["median"]), num(s["completion_tokens_per_task"]["p95"])), "",
             "Token 口径：%s；供应商报告 %d 次请求、网关估算 %d 次、usage 口径未知 %d 次；%d 个任务包含估算，%d 次请求缺少 usage。"
             % ("包含估算" if s["usage"]["estimated"] else "网关记录的供应商报告 tokens", s["usage"]["provider_reported_requests"],
                s["usage"]["estimated_requests"], s["usage"]["unknown_usage_requests"], s["usage"]["tasks_with_estimates"], s["usage"]["missing_usage_requests"]), "",
             "正式运行费用范围：高峰 **%s**；半价离峰 **%s**。按每百万 tokens：输入缓存未命中 ¥9、缓存命中 ¥0.3、输出 ¥27。"
             "缓存命中明细和实际计费时段未知，这只是区间估计，不是精确账单。" % (bounds(s["cost_estimate"]), bounds(s["cost_estimate"], False)), ""]
    lines[6:6] = [metrics["protocol_note"] + (" [冻结 v2 文本证据](protocol-v2/README.md)。" if metrics.get("historical_run") else ""), ""]
    if metrics.get("user_reported_cost"):
        receipt = metrics["user_reported_cost"]
        lines[4:4] = ["**用户提供费用 %s（含校准），%s API 请求，%s tokens。**"
                      % (money(receipt["amount"]), num(receipt["api_requests"]), num(receipt["tokens"])),
                      "Token 合计与正式运行加校准记录一致；这是用户提供的统计，未独立核验账单。API 侧请求数与本地 %s 次网关尝试（正式 %s + 校准 %s）口径不同，不能混算。"
                      % (num(receipt["local_gateway_attempts"]), num(s["model_requests"]), num(metrics["pilot"]["model_requests"])), ""]
    if metrics.get("pilot"):
        p = metrics["pilot"]
        total = metrics["combined_usage"]
        lines += ["前置预跑另用了 %s 输入 / %s 输出 tokens（estimated=%s，%s 次模型请求），不进入正式成绩。"
                  % (num(p["usage"]["prompt_tokens"]), num(p["usage"]["completion_tokens"]), p["usage"].get("estimated"), num(p["model_requests"])),
                  "正式运行加预跑的费用范围：高峰 %s；半价离峰 %s。" % (bounds(total["cost_estimate"]), bounds(total["cost_estimate"], False)), ""]
    lines += ["## 失败题", "", "| 任务 | 函数 | 生成状态 | 官方检查状态 | 原因 |", "|---|---|---|---|---|"]
    if failed:
        for row in failed:
            lines.append("| %s | `%s` | %s | %s | %s |" % tuple(md_cell(row[key]) for key in ("task_id", "function", "generation_status", "checker_status", "reason")))
    else:
        lines.append("| — | — | — | — | 全部通过 |")
    lines += ["", "## 复现证据", "",
              "官方 checker commit `%s`，原始数据 SHA256 `%s`。"
              % (source["official_checker"]["commit"], source["dataset_sha256"]),
              "CLI source SHA256 `%s`；adapter SHA256 `%s`；系统 prompt SHA256 `%s`。"
              % (source["cli"]["source_sha256"], source["cli"]["adapter_sha256"], source["cli"]["system_prompt_sha256"]),
              "所有 164 个任务、计数、模型标识、公开 prompt 哈希、生成/评分 solution 哈希及 tokens/request 合计一致性均已断言。",
              "canonical 自检 164/164 通过，错误实现确实触发断言；正式 agent 和评分器分别在 macOS 文件/网络隔离中执行。",
              "公开题可能出现在训练材料中，本次禁止隐藏测试反馈不等于证明没有训练污染。", "",
              "[交互报告](report.html) · [任务 CSV](tasks.csv) · [机器可读指标](metrics.json)",
              "原始生成和会话结果目录：`%s`。" % str(root), "",
              "来源：[HumanEval](%s)、[官方 checker](%s)、[DeepSeek 价格](%s)。"
              % (SOURCES["HumanEval"], SOURCES["officialChecker"], SOURCES["DeepSeekPricing"]), ""]
    return "\n".join(lines)


HTML = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知趣 × DeepSeek · HumanEval 评测</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182224;background:#f2f4f2;line-height:1.55}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:44px 30px}h1{font-size:34px;font-weight:550;letter-spacing:-1px;margin:0 0 12px}h2{font-size:20px;font-weight:550;margin:0 0 14px}.eyebrow{font-size:12px;letter-spacing:.16em;color:#596862;margin-bottom:10px}.intro{max-width:970px;color:#57615d}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:26px 0}.card,.panel{background:#fff;border:1px solid #dce2dc;border-radius:16px;padding:20px}.number{font-size:32px;line-height:1.2;font-weight:500;letter-spacing:-1px}.label,.note{font-size:13px;color:#5c6860}.label{margin-top:9px}.split{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}.protocol{display:grid;grid-template-columns:140px 1fr;gap:6px;font-size:14px}.protocol dt{color:#626f66}.protocol dd{margin:0;overflow-wrap:anywhere}.money{font-size:22px}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:28px 0 14px}input,select,button{font:inherit;background:white;border:1px solid #c7d2c8;border-radius:9px;padding:10px 13px}input{min-width:270px;flex:1}button{cursor:pointer}button:hover{background:#edf2ec}#count{margin-left:auto;font-size:14px;color:#5d685f}.table-wrap{overflow:auto;border:1px solid #dce2dc;border-radius:14px;background:white}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:13px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e8ece8}th{position:sticky;top:0;background:#f6f8f5;font-weight:550;color:#4f5b52}td.num{text-align:right;font-variant-numeric:tabular-nums}.badge{display:inline-block;padding:3px 8px;border-radius:20px;font-size:11px;letter-spacing:.05em}.pass{background:#e4f2e6;color:#21643a}.fail{background:#fbe8e3;color:#9a382a}.detail{white-space:normal;background:#f9faf8}.detail p{margin:2px 0;overflow-wrap:anywhere;max-width:1100px}details{margin-top:14px}summary{cursor:pointer;color:#47594b}code{font-size:12px;overflow-wrap:anywhere}a{color:#276042}footer{font-size:13px;color:#5e6d63;margin:22px 0}.smallbtn{padding:4px 9px;font-size:12px}.alert{background:#fff9ed;border:1px solid #e4d9b9;padding:12px 16px;border-radius:10px;margin-top:18px;color:#725c2e}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.chip{background:#f1f4ef;border-radius:7px;padding:4px 9px;font-size:12px}.empty{text-align:center;padding:30px;color:#666}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:1000px){.stats{grid-template-columns:repeat(3,1fr)}.split{grid-template-columns:1fr}}@media(max-width:620px){main{padding:26px 16px}h1{font-size:27px}.stats{grid-template-columns:repeat(2,1fr)}.number{font-size:28px}.protocol{grid-template-columns:100px 1fr}input{min-width:100%;width:100%}.toolbar{gap:8px}}
</style></head><body><main>
<div class="eyebrow">ZHIQU CLI · HUMAN EVAL · ONE AGENT EPISODE / TASK</div>
<h1>知趣 CLI × DeepSeek-v4-pro</h1>
<p class="intro">164 道 Python 函数实现题；原有 agent 循环读取、编辑文件并调用本地工具，最后由官方隐藏测试评分。该成绩代表模型与知趣工具循环的组合能力。它不是 SWE-bench 仓库修复成绩，也不是纯模型排行榜排名。</p>
<p class="note">@@RUNNOTE@@</p>
<div class="stats">@@CARDS@@</div>
<div class="split"><section class="panel"><h2>评测协议与结果</h2><dl class="protocol">@@PROTOCOL@@</dl><div class="chips">@@COUNTS@@</div></section>
<section class="panel"><h2>@@COSTTITLE@@</h2><div class="money">@@COST@@</div><p class="note">@@COSTNOTE@@</p><dl class="protocol">@@USAGE@@</dl><p class="note">输入缓存命中明细与计费时段未知；这里的区间不等于账单。高峰每百万 tokens：输入未命中 ¥9、命中 ¥0.3、输出 ¥27，离峰半价。</p>@@PILOT@@</section></div>
<div class="alert">所有 164 题进入分母，包括 prompt 前缀被改动的协议错误。没有隐藏测试反馈、重跑择优或 best-of 合并。前置限流预跑不进入正式成绩。<br>@@PROTOCOLNOTE@@</div>
<div class="toolbar"><label class="sr" for="search">搜索任务或函数</label><input id="search" type="search" placeholder="搜索任务编号或函数，如 HumanEval/0、median" autocomplete="off"><label class="sr" for="status">筛选通过或失败</label><select id="status"><option value="all">全部任务</option><option value="passed">通过</option><option value="failed">失败</option><option value="generation">生成或协议失败</option><option value="checker">官方检查失败</option></select><button id="reset" type="button">重置</button><span id="count" role="status" aria-live="polite"></span></div>
<div class="table-wrap"><table><thead><tr><th>任务 / 函数</th><th>结果</th><th>生成状态</th><th>检查状态</th><th>耗时 s</th><th>请求</th><th>工具</th><th>输入 tokens</th><th>输出 tokens</th><th>详情</th></tr></thead><tbody id="rows"></tbody></table></div>
<details class="panel"><summary>查看复现证据与口径</summary><div class="note">@@EVIDENCE@@</div></details>
<footer>全部资源内嵌，搜索与筛选在本机完成。公开题可能出现在训练材料中；禁止测试反馈不等于证明没有训练污染。<br>来源：<a href="https://github.com/openai/human-eval">HumanEval</a> · <a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/">DeepSeek 价格</a></footer>
</main><script type="application/json" id="task-data">@@DATA@@</script><script>
"use strict";
const tasks=JSON.parse(document.getElementById("task-data").textContent);
const search=document.getElementById("search"),status=document.getElementById("status"),body=document.getElementById("rows"),count=document.getElementById("count");
function td(value,cls){const cell=document.createElement("td");cell.textContent=String(value);if(cls)cell.className=cls;return cell;}
function render(){const q=search.value.trim().toLowerCase(),f=status.value;const chosen=tasks.filter(t=>((t.task_id+" "+t.function).toLowerCase().includes(q))&&(f==="all"||(f==="passed"&&t.passed)||(f==="failed"&&!t.passed)||f===t.failure_group));body.replaceChildren();count.textContent="显示 "+chosen.length+" / 164 题";
for(const task of chosen){const row=document.createElement("tr"),name=document.createElement("td"),id=document.createElement("div"),fn=document.createElement("code");id.textContent=task.task_id;fn.textContent=task.function;name.append(id,fn);row.append(name);const verdict=document.createElement("td"),badge=document.createElement("span");badge.className="badge "+(task.passed?"pass":"fail");badge.textContent=task.passed?"PASS":"FAIL";verdict.append(badge);row.append(verdict,td(task.generation_status),td(task.checker_status),td((task.duration_ms/1000).toFixed(2),"num"),td(task.requests,"num"),td(task.tools,"num"),td(task.prompt_tokens.toLocaleString(),"num"),td(task.completion_tokens.toLocaleString(),"num"));const action=document.createElement("td"),button=document.createElement("button");button.type="button";button.className="smallbtn";button.textContent="展开";button.setAttribute("aria-expanded","false");button.setAttribute("aria-label","查看 "+task.task_id+" 详情");action.append(button);row.append(action);body.append(row);const detail=document.createElement("tr");detail.className="detail";detail.hidden=true;const cell=document.createElement("td");cell.colSpan=10;const reason=document.createElement("p");reason.textContent="原因："+(task.reason||"通过官方测试");const evidence=document.createElement("p");evidence.className="note";evidence.textContent="轮数 "+task.rounds+" · 校验 "+task.verification_duration_ms+" ms · transport wait "+task.transport_wait_ms+" ms · solution SHA256 "+(task.solution_sha256||"无可评分文件");cell.append(reason,evidence);detail.append(cell);body.append(detail);button.addEventListener("click",()=>{detail.hidden=!detail.hidden;button.textContent=detail.hidden?"展开":"收起";button.setAttribute("aria-expanded",String(!detail.hidden));});}
if(!chosen.length){const row=document.createElement("tr"),cell=td("没有匹配的任务","empty");cell.colSpan=10;row.append(cell);body.append(row);}}
search.addEventListener("input",render);status.addEventListener("change",render);document.getElementById("reset").addEventListener("click",()=>{search.value="";status.value="all";render();search.focus();});render();
</script></body></html>'''


def html_report(metrics):
    s = metrics["statistics"]
    p = metrics["protocol"]
    esc = lambda value: html.escape(str(value), quote=True)
    cards = [("%d / 164" % s["passed"], "单次 agent episode 成功 · %.2f%%" % (s["agent_episode_success_rate"] * 100)),
             (str(s["generation_failures"]), "生成或协议失败"), (str(s["checker_failures"]), "官方检查失败"),
             ("%.1f min" % (s["elapsed_seconds"] / 60), "正式运行总耗时"), (num(s["model_requests"]), "模型请求"),
             (num(s["tool_calls"]), "工具调用")]
    dl = lambda pairs: "".join("<dt>%s</dt><dd>%s</dd>" % (esc(k), esc(v)) for k, v in pairs)
    protocols = [("模型 / 上下文", metrics["model"]["modelName"] + " / " + num(metrics["model"]["effectiveContextWindow"]) + " tokens"),
                 ("任务协议", "164 题 × 1 episode；文件前缀必须精确保留"),
                 ("前缀协议失败", "%d 题，单列为指令/格式遵循失败" % s["prefix_protocol_failures"]),
                 ("其他协议失败", "%d 题，如缺实际模型证据、无实现" % s["other_protocol_failures"]),
                 ("资源上限", "20 轮 / 300 秒 / 2 并发 / 50 rpm；测试 3 秒"),
                 ("运行时间", local_time(p["started_at"]) + " 至 " + local_time(p["finished_at"])),
                 ("单题耗时", "median %.2f s · p95 %.2f s" % (s["task_duration_ms"]["median"] / 1000, s["task_duration_ms"]["p95"] / 1000)),
                 ("CLI commit", metrics["source"]["cli"]["commit"]), ("dirty", metrics["source"]["cli"]["dirty"])]
    usage = [("输入 tokens", num(s["usage"]["prompt_tokens"])), ("输出 tokens", num(s["usage"]["completion_tokens"])),
             ("usage 口径", "包含网关估算" if s["usage"]["estimated"] else "网关记录供应商报告 tokens"),
             ("请求 usage", "%d 供应商报告 / %d 估算 / %d 未知" % (s["usage"]["provider_reported_requests"], s["usage"]["estimated_requests"], s["usage"]["unknown_usage_requests"])),
             ("每题模型请求", "median %s · p95 %s" % (num(s["requests_per_task"]["median"], 1), num(s["requests_per_task"]["p95"]))),
             ("每题工具调用", "median %s · p95 %s" % (num(s["tools_per_task"]["median"], 1), num(s["tools_per_task"]["p95"])))]
    pilot = ""
    if metrics.get("pilot"):
        pilot_data = metrics["pilot"]
        pilot = "<p class=\"note\">预跑额外 %s 输入 / %s 输出 tokens（estimated=%s），不进入成绩。正式加预跑高峰 %s；半价离峰 %s。</p>" % tuple(esc(x) for x in
                (num(pilot_data["usage"]["prompt_tokens"]), num(pilot_data["usage"]["completion_tokens"]), pilot_data["usage"].get("estimated"),
                 bounds(metrics["combined_usage"]["cost_estimate"]), bounds(metrics["combined_usage"]["cost_estimate"], False)))
    evidence = "".join("<p>%s</p>" % esc(line) for line in (
        "164 个任务、模型标识、公开 prompt 哈希、生成/评分 solution 哈希及请求/token合计均通过一致性断言。",
        "官方 canonical 自检164/164；错误实现实际触发断言。评分器与 agent 分别执行 macOS 文件与网络隔离。",
        "Dataset SHA256: " + metrics["source"]["dataset_sha256"],
        "Official checker commit: " + metrics["source"]["official_checker"]["commit"],
        "CLI source SHA256: " + metrics["source"]["cli"]["source_sha256"],
        "Adapter SHA256: " + metrics["source"]["cli"]["adapter_sha256"],
        "System prompt SHA256: " + metrics["source"]["cli"]["system_prompt_sha256"],
        "Protocol-error final solution bytes were compared with their public task prompts; no candidate file was changed.",
        "Report built from final artifacts only; no model calls or hidden grading occurs in this builder."))
    evidence = "<p>%s</p>" % esc(metrics["protocol_note"]) + evidence
    data = json.dumps(metrics["tasks"], ensure_ascii=False, separators=(",", ":"))
    data = data.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    cost_title = "用量与费用区间"
    cost_headline = esc(bounds(s["cost_estimate"])) + "<span class=\"note\"> 高峰 CNY</span>"
    cost_note = "半价离峰 " + bounds(s["cost_estimate"], False)
    if metrics.get("user_reported_cost"):
        receipt = metrics["user_reported_cost"]
        cost_title = "用量与用户费用统计"
        cost_headline = esc("用户提供费用 " + money(receipt["amount"])) + "<span class=\"note\">（含校准）</span>"
        cost_note = "%s API 请求，%s tokens；token 合计与正式加校准记录一致，未独立核验账单。API 侧统计与本地 %s 次网关尝试口径不同。正式运行理论参考：高峰 %s；半价离峰 %s。" % (
            num(receipt["api_requests"]), num(receipt["tokens"]), num(receipt["local_gateway_attempts"]),
            bounds(s["cost_estimate"]), bounds(s["cost_estimate"], False))
    replacements = {"@@CARDS@@": "".join("<div class=\"card\"><div class=\"number\">%s</div><div class=\"label\">%s</div></div>" % (esc(value), esc(label)) for value, label in cards),
                    "@@RUNNOTE@@": esc(metrics["protocol_note"]),
                    "@@PROTOCOL@@": dl(protocols), "@@COUNTS@@": "".join("<span class=\"chip\">%s: %s</span>" % (esc(k), esc(v)) for k, v in s["checker_counts"].items()),
                    "@@COSTTITLE@@": esc(cost_title), "@@COST@@": cost_headline,
                    "@@COSTNOTE@@": esc(cost_note), "@@USAGE@@": dl(usage),
                    "@@PILOT@@": pilot, "@@EVIDENCE@@": evidence, "@@DATA@@": data,
                    "@@PROTOCOLNOTE@@": esc(metrics["protocol_review"]["note"])}
    return re.sub(r"@@[A-Z]+@@", lambda match: replacements[match.group(0)], HTML)


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--pilot-dir", type=Path)
    parser.add_argument("--cost-stats", type=Path, help="Optional user-reported formal-plus-calibration cost/API/token statistics")
    args = parser.parse_args()
    root = args.run_dir.resolve()
    # No output is written until all input assertions pass.
    manifest, score, tasks, stats = verify_run(root)
    selftest = read_json(root / "verifier-self-test.json")
    require(selftest.get("status") == "self_test_passed" and selftest.get("selfTest", {}).get("canonicalPassed") == 164
            and selftest.get("selfTest", {}).get("verified") is True, "Verifier green/red self-test is absent or failed")
    require(selftest.get("sourceSha256") == score.get("sourceSha256")
            and selftest.get("officialSource", {}).get("executionSha256") == score.get("officialSource", {}).get("executionSha256"),
            "Verifier self-test and scored run use different official sources")
    require(score.get("isolation", {}).get("verifiedByThisScript") is True, "Official verification isolation not demonstrated")
    pilot = pilot_at(args.pilot_dir.resolve() if args.pilot_dir else None)
    metrics = {"benchmark": "HumanEval", "protocol_name": "one zhiqu file-editing agent episode per task",
               "statistics": stats, "model": manifest["model"], "protocol": {
                   key: manifest.get(key) for key in ("version", "started_at", "finished_at", "max_rounds", "timeout_seconds", "concurrency",
                                                     "requests_per_minute", "min_request_interval_ms", "samples_per_task", "thinking", "temperature", "permissions", "prompt_protocol")},
               "source": {"dataset_sha256": manifest["dataset_sha256"], "dataset_uncompressed_sha256": manifest["dataset_uncompressed_sha256"],
                          "cli": manifest["source"], "official_checker": score["officialSource"],
                          "manifest_sha256": sha((root / "manifest.json").read_bytes()), "score_sha256": sha((root / "score.json").read_bytes())},
               "isolation": score["isolation"], "prices": PRICES, "pilot": pilot, "sources": SOURCES,
               "comparable_to_swe_bench": False, "comparable_to_pure_model_leaderboard": False,
               "test_feedback_given_to_agent": False, "best_of_or_retries": False,
               "integrity_checks_passed": True, "tasks": tasks}
    metrics["report_builder"] = {"path": "tools/benchmarks/build-humaneval-report.py",
                                 "sha256": sha(Path(__file__).read_bytes()),
                                 "scope": "full164 protocol v2/v3 + deepseek-v4-pro + 1M context + 20 rounds/300s/2 workers/50rpm"}
    metrics["historical_run"] = (manifest["version"] == 2 and manifest["source"]["adapter_sha256"] == HISTORICAL_ADAPTER_SHA256
                                 and manifest.get("fingerprint") == HISTORICAL_FINGERPRINT)
    if metrics["historical_run"]:
        metrics["historical_note"] = HISTORICAL_NOTE
        metrics["protocol_note"] = HISTORICAL_NOTE
    elif manifest["version"] == 2:
        metrics["protocol_note"] = "此结果使用评测后防御修复之前的 v2 协议，不能作为当前 v3 已重测的证据；报告只读取本次已完成的实际生成和评分产物。"
    else:
        metrics["protocol_note"] = "此报告按 manifest 中的 v3 协议和本次实际评分产物生成，不继承 v2 历史成绩；运行日期、指纹和得分以本次记录为准。"
    reviews = stats["protocol_reviews"]
    reviewed_protocol_ids = [review["task_id"] for review in reviews]
    prefix_reviews = [review for review in reviews if review["prefix_changed"]]
    prefix_ids = [review["task_id"] for review in prefix_reviews]
    review_note = "协议失败不自动等同算法错误；正式成绩仍按既定严格前缀协议计失败，不修复重试。"
    if prefix_reviews and all(review["only_leading_blank_line_removed"] for review in prefix_reviews):
        review_note = "已逐字节复核 %s：均删除了一个开头换行，通常不影响 Python 语义，属于格式/指令遵循失败；仍按既定协议计失败，不修复重试。" % "、".join(prefix_ids)
    elif prefix_reviews:
        review_note = "已逐字节复核 %s：%d 题只删除一个开头换行，其余前缀有其他改动；协议失败不直接说明算法是否正确，仍按既定协议计失败。" % ("、".join(prefix_ids), sum(review["only_leading_blank_line_removed"] for review in prefix_reviews))
    if stats["other_protocol_failures"]:
        review_note += "另有 %d 题前缀未改动的协议失败，按模型证据缺失、无实现或其他原因单列，未进行官方测试。" % stats["other_protocol_failures"]
    metrics["protocol_review"] = {"reviewed_task_ids": reviewed_protocol_ids,
                                  "review_source": "Builder compares public prompt with final solution bytes without execution or modification",
                                  "reviews": reviews, "note": review_note}
    if pilot:
        prompt = stats["usage"]["prompt_tokens"] + pilot["usage"]["prompt_tokens"]
        completion = stats["usage"]["completion_tokens"] + pilot["usage"]["completion_tokens"]
        metrics["combined_usage"] = {"prompt_tokens": prompt, "completion_tokens": completion,
                                     "estimated": bool(stats["usage"]["estimated"] or pilot["usage"].get("estimated")),
                                     "cost_estimate": cost_range(prompt, completion)}
    if args.cost_stats:
        metrics["user_reported_cost"] = cost_stats_at(args.cost_stats, metrics)
    text = markdown(metrics, root)
    page = html_report(metrics)
    require(all(marker not in page for marker in ("@@DATA@@", "@@CARDS@@", "@@PROTOCOL@@")), "HTML template was not fully expanded")
    (root / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "summary.md").write_text(text, encoding="utf-8")
    (root / "report.html").write_text(page, encoding="utf-8")
    fields = ["task_id", "function", "passed", "generation_status", "primary_status", "checker_status", "checker_result", "failure_group", "reason", "duration_ms",
              "verification_duration_ms", "requests", "rounds", "tools", "prompt_tokens", "completion_tokens", "tokens_estimated", "transport_wait_ms", "solution_sha256"]
    with (root / "tasks.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows({key: csv_value(row[key]) for key in fields} for row in tasks)
    print(json.dumps({"passed": stats["passed"], "denominator": 164, "passRate": stats["agent_episode_success_rate"],
                      "artifacts": [str(root / name) for name in ("summary.md", "metrics.json", "tasks.csv", "report.html")]}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print("Report refused: " + str(exc), file=sys.stderr)
        sys.exit(2)
