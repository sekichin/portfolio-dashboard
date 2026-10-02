from __future__ import annotations

import copy
import gzip
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo


class CloudStoreError(RuntimeError):
    pass


class CloudConflictError(CloudStoreError):
    pass


def enabled() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


def _settings() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise CloudStoreError("Supabase 环境变量尚未配置")
    return url, key


def _request(
    path: str,
    *,
    method: str = "GET",
    payload: object | None = None,
    prefer: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> object:
    url, key = _settings()
    body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    if extra_headers:
        headers.update(extra_headers)
    request = urllib.request.Request(f"{url}/rest/v1/{path.lstrip('/')}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                raw = gzip.decompress(raw)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise CloudStoreError(f"Supabase {error.code}: {detail}") from error
    except OSError as error:
        raise CloudStoreError(f"Supabase 连接失败：{error}") from error
    return json.loads(raw) if raw else None


def _profile_query(profile_id: str) -> str:
    return urllib.parse.urlencode({"profile_id": f"eq.{profile_id}", "select": "core,revision,updated_at"})


def read_core(profile_id: str) -> tuple[dict | None, int, str | None]:
    rows = _request(f"portfolio_profiles?{_profile_query(profile_id)}")
    if not isinstance(rows, list) or not rows:
        return None, 0, None
    row = rows[0]
    core = row.get("core") if isinstance(row, dict) else None
    return (copy.deepcopy(core) if isinstance(core, dict) else None, int(row.get("revision") or 0), row.get("updated_at"))


def read_history(profile_id: str) -> list[dict]:
    result: list[dict] = []
    offset = 0
    batch_size = 1000
    while True:
        query = urllib.parse.urlencode({
            "profile_id": f"eq.{profile_id}",
            "select": "day,data",
            "order": "day.asc",
            "offset": str(offset),
            "limit": str(batch_size),
        })
        rows = _request(f"portfolio_history?{query}")
        if not isinstance(rows, list):
            raise CloudStoreError("Supabase 历史数据格式不正确")
        for row in rows:
            data = row.get("data") if isinstance(row, dict) else None
            if isinstance(data, dict):
                item = copy.deepcopy(data)
                item.setdefault("date", row.get("day"))
                result.append(item)
        if len(rows) < batch_size:
            break
        offset += batch_size
    return result


def read_recent_history(profile_id: str, limit: int = 3) -> list[dict]:
    query = urllib.parse.urlencode({
        "profile_id": f"eq.{profile_id}",
        "select": "day,data",
        "order": "day.desc",
        "limit": str(max(1, min(int(limit), 30))),
    })
    rows = _request(f"portfolio_history?{query}")
    if not isinstance(rows, list):
        raise CloudStoreError("Supabase 历史数据格式不正确")
    result: list[dict] = []
    for row in reversed(rows):
        data = row.get("data") if isinstance(row, dict) else None
        if isinstance(data, dict):
            item = copy.deepcopy(data)
            item.setdefault("date", row.get("day"))
            result.append(item)
    return result


def read_portfolio_core(profile_id: str, recent_history_limit: int = 0) -> dict | None:
    if recent_history_limit:
        with ThreadPoolExecutor(max_workers=2) as executor:
            core_future = executor.submit(read_core, profile_id)
            history_future = executor.submit(read_recent_history, profile_id, recent_history_limit)
            core, revision, updated_at = core_future.result()
            recent_history = history_future.result()
    else:
        core, revision, updated_at = read_core(profile_id)
        recent_history = []
    if core is None:
        return None
    core["history"] = recent_history
    core["_cloudRevision"] = revision
    if profile_id == "friend":
        core["_profileRevision"] = revision
        core["_profileSavedAt"] = updated_at
    return core


def read_portfolio(profile_id: str) -> dict | None:
    with ThreadPoolExecutor(max_workers=2) as executor:
        core_future = executor.submit(read_core, profile_id)
        history_future = executor.submit(read_history, profile_id)
        core, revision, updated_at = core_future.result()
        history = history_future.result()
    if core is None:
        return None
    core["history"] = history
    core["_cloudRevision"] = revision
    if profile_id == "friend":
        core["_profileRevision"] = revision
        core["_profileSavedAt"] = updated_at
    return core


def _write_history(profile_id: str, history: list[dict]) -> None:
    rows = [
        {"profile_id": profile_id, "day": item.get("date"), "data": item}
        for item in history
        if isinstance(item, dict) and item.get("date")
    ]
    for start in range(0, len(rows), 100):
        _request(
            "portfolio_history?on_conflict=profile_id,day",
            method="POST",
            payload=rows[start:start + 100],
            prefer="resolution=merge-duplicates,return=minimal",
        )


def write_history_snapshots(profile_id: str, history: list[dict]) -> None:
    _write_history(profile_id, history)


def delete_history_days(profile_id: str, days: list[str]) -> None:
    valid_days = sorted({str(day) for day in days if day})
    for day in valid_days:
        query = urllib.parse.urlencode({
            "profile_id": f"eq.{profile_id}",
            "day": f"eq.{day}",
        })
        _request(
            f"portfolio_history?{query}",
            method="DELETE",
            prefer="return=minimal",
        )


def write_portfolio(profile_id: str, data: dict, expected_revision: int | None = None) -> dict:
    current_core, current_revision, _ = read_core(profile_id)
    if expected_revision is not None and current_core is not None and expected_revision != current_revision:
        raise CloudConflictError("持仓已在另一台设备更新，请刷新页面后重试")
    saved = copy.deepcopy(data)
    history = saved.pop("history", None)
    if history is None:
        history = read_history(profile_id) if current_core is not None else []
    if not isinstance(history, list):
        raise CloudStoreError("历史数据格式不正确")
    saved.pop("_cloudRevision", None)
    saved.pop("_profileRevision", None)
    saved.pop("_profileSavedAt", None)
    next_revision = current_revision + 1
    now = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    rows = _request(
        "portfolio_profiles?on_conflict=profile_id",
        method="POST",
        payload={"profile_id": profile_id, "core": saved, "revision": next_revision, "updated_at": now},
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise CloudStoreError("Supabase 未返回保存结果")
    _write_history(profile_id, history)
    saved["history"] = history
    if profile_id == "friend":
        saved["_profileRevision"] = next_revision
        saved["_profileSavedAt"] = now
    return saved


def write_live_snapshot(profile_id: str, data: dict, expected_revision: int) -> bool:
    saved = copy.deepcopy(data)
    history = saved.pop("history", [])
    if not isinstance(history, list):
        raise CloudStoreError("历史数据格式不正确")
    saved.pop("_cloudRevision", None)
    saved.pop("_profileRevision", None)
    saved.pop("_profileSavedAt", None)
    query = urllib.parse.urlencode({
        "profile_id": f"eq.{profile_id}",
        "revision": f"eq.{expected_revision}",
        "select": "revision",
    })
    rows = _request(
        f"portfolio_profiles?{query}",
        method="PATCH",
        payload={"core": saved},
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        return False
    _write_history(profile_id, history)
    return True


def write_daily_ai_summary(profile_id: str, date_text: str, report: dict, limit: int = 60) -> dict:
    core, revision, _ = read_core(profile_id)
    if core is None:
        raise CloudStoreError("云端持仓尚未建立")
    summaries = core.get("dailyAiSummaries")
    summaries = copy.deepcopy(summaries) if isinstance(summaries, dict) else {}
    summaries[date_text] = copy.deepcopy(report)
    kept_dates = sorted(summaries)[-max(1, int(limit)):]
    core["dailyAiSummaries"] = {day: summaries[day] for day in kept_dates}
    now = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    query = urllib.parse.urlencode({
        "profile_id": f"eq.{profile_id}",
        "revision": f"eq.{revision}",
        "select": "revision",
    })
    rows = _request(
        f"portfolio_profiles?{query}",
        method="PATCH",
        payload={"core": core, "updated_at": now},
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise CloudConflictError("持仓已在另一台设备更新，请重新保存日报")
    return copy.deepcopy(report)


def read_goal_settings(profile_id: str) -> dict | None:
    query = urllib.parse.urlencode({"profile_id": f"eq.{profile_id}", "select": "settings"})
    rows = _request(f"goal_settings?{query}")
    if not isinstance(rows, list) or not rows:
        return None
    settings = rows[0].get("settings")
    return copy.deepcopy(settings) if isinstance(settings, dict) else None


def write_goal_settings(profile_id: str, settings: dict) -> dict:
    now = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    _request(
        "goal_settings?on_conflict=profile_id",
        method="POST",
        payload={"profile_id": profile_id, "settings": settings, "updated_at": now},
        prefer="resolution=merge-duplicates,return=minimal",
    )
    return copy.deepcopy(settings)
