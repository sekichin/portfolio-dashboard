#!/usr/bin/env python3
"""A small local portfolio dashboard for US and Japanese stocks."""

from __future__ import annotations

import asyncio
import csv
import copy
import gzip
import hashlib
import hmac
import importlib
import json
import math
import os
import re
import secrets
import shutil
import ssl
import threading
import time
import traceback
import urllib.parse
import urllib.request
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.cookies import SimpleCookie
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo


def load_local_environment() -> None:
    env_file = Path(__file__).resolve().parent / ".env.local"
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name:
            os.environ.setdefault(name, value)


load_local_environment()

try:
    import cloud_store
except ImportError:
    cloud_store = None

try:
    import gemini_ai
except ImportError:
    gemini_ai = None

yfinance = None

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "portfolio.json"
GOAL_SIMULATOR_FILE = ROOT / "data" / "goal-simulator.json"
PROMPT_FILE = ROOT / "analysis-prompt.md"
ACCESS_TOKEN_FILE = ROOT / "data" / "access-token.txt"
FRIEND_PROFILE_TOKEN_FILE = ROOT / "data" / "friend-profile-token.txt"
OWNER_LOGIN_KEY_FILE = ROOT / "data" / "owner-login-key.txt"
FRIEND_LOGIN_KEY_FILE = ROOT / "data" / "friend-login-key.txt"
TEST_RUNTIME_DATA_DIR = Path(
    os.environ.get("PORTFOLIO_TEST_RUNTIME_DATA_DIR", str(Path.home() / ".portfolio-dashboard-ledger-test"))
).expanduser()
TEST_ACCOUNTS_FILE = TEST_RUNTIME_DATA_DIR / "test-accounts.json"
TEST_USER_DATA_DIR = TEST_RUNTIME_DATA_DIR / "test-users"
FRIEND_PROFILE_FILE = ROOT / "data" / "friend-portfolio.json"
FRIEND_GOAL_SIMULATOR_FILE = ROOT / "data" / "friend-goal-simulator.json"
GOLD_HISTORY_FILE = ROOT / "data" / "rakuten-gold-history.json"
HOST = os.environ.get("PORTFOLIO_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORTFOLIO_PORT", "8765"))
FUND_IDS = {
    "FANG+（iFreeNEXT）": "JP90C000FZD4",
    "eMAXIS Slim S&P500": "JP90C000GKC6",
    "eMAXIS NASDAQ100": "JP90C000L9D2",
    "ニッセイNASDAQ100": "JP90C000PDY6",
    "eMAXIS Slim TOPIX": "JP90C000ENA9",
    "楽天印度Nifty50": "JP90C000QLX9",
}
SMBC_FUND_CODES = {
    "SMBC・DCインデックスファンド(日経225)": "182709",
    "SMBC・DCインデックスファンド(MSCIコクサイ)": "182909",
    "SMBC・DCインデックスファンド(S&P500)": "182809",
    "225": "182709",
    "全球": "182909",
    "500": "182809",
}
TOPIX_BENCHMARK_FUND_ID = "JP90C000ENA9"
TROY_OUNCE_GRAMS = 31.1034768
LIVE_QUOTE_INTERVAL_SECONDS = 20
SLOW_QUOTE_INTERVAL_SECONDS = 60 * 60
LIVE_SNAPSHOT_PERSIST_INTERVAL_SECONDS = 5 * 60
STREAM_HEARTBEAT_SECONDS = 20
EXTENDED_QUOTE_MAX_AGE_SECONDS = 72 * 60 * 60
DATA_LOCK = threading.RLock()
FRIEND_PROFILE_LOCK = threading.RLock()
LIVE_CONDITION = threading.Condition(threading.RLock())
STREAM_QUOTE_CACHE_LOCK = threading.RLock()
STREAM_QUOTE_CACHE: dict[str, dict] = {}
LIVE_STATE: dict = {
    "revision": 0,
    "lastRefreshAt": None,
    "fx": {},
    "holdings": [],
    "currentHistory": None,
    "errors": [],
}
QUOTE_WAKE_EVENT = threading.Event()
STREAM_WAKE_EVENT = threading.Event()
GOLD_CACHE_LOCK = threading.RLock()
LAST_STREAM_SNAPSHOT_AT = 0.0
GOLD_SPOT_CACHE: dict = {"expiresAt": 0.0, "payload": None}
GOLD_HISTORY_CACHE: dict = {"expiresAt": 0.0, "prices": {}}
CLOUD_MODE = bool(cloud_store and cloud_store.enabled())


def write_runtime_default(path: Path, value: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{value}\n", encoding="utf-8")
    except OSError:
        pass


def read_access_token() -> str:
    configured = os.environ.get("PORTFOLIO_ACCESS_TOKEN", "").strip()
    if configured:
        return configured
    if ACCESS_TOKEN_FILE.exists():
        token = ACCESS_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    write_runtime_default(ACCESS_TOKEN_FILE, token)
    return token


ACCESS_TOKEN = read_access_token()


def read_friend_profile_token() -> str:
    configured = os.environ.get("PORTFOLIO_FRIEND_TOKEN", "").strip()
    if configured:
        return configured
    if FRIEND_PROFILE_TOKEN_FILE.exists():
        token = FRIEND_PROFILE_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    write_runtime_default(FRIEND_PROFILE_TOKEN_FILE, token)
    return token


FRIEND_PROFILE_TOKEN = read_friend_profile_token()


def read_login_key(path: Path, fallback: str, environment_name: str) -> str:
    configured = os.environ.get(environment_name, "").strip()
    if configured:
        return configured
    if path.exists():
        key = path.read_text(encoding="utf-8").strip()
        if key:
            return key
    write_runtime_default(path, fallback)
    return fallback


OWNER_LOGIN_KEY = read_login_key(OWNER_LOGIN_KEY_FILE, secrets.token_urlsafe(18), "OWNER_LOGIN_KEY")
FRIEND_LOGIN_KEY = read_login_key(FRIEND_LOGIN_KEY_FILE, secrets.token_urlsafe(18), "FRIEND_LOGIN_KEY")
ADMIN_LOGIN_KEY = os.environ.get("PORTFOLIO_ADMIN_KEY", "").strip()
ADMIN_SESSION_TOKEN = hashlib.sha256(f"{ADMIN_LOGIN_KEY}:{ACCESS_TOKEN}".encode()).hexdigest()
TRIAL_CREATED_TOKEN = hmac.new(ACCESS_TOKEN.encode(), b"trial-created-v1", hashlib.sha256).hexdigest()
TEST_ACCOUNTS_LOCK = threading.RLock()
AI_DAILY_LIMIT = 5


def login_key_hash(value: str) -> str:
    return hashlib.sha256(value.strip().upper().encode()).hexdigest()


def read_test_accounts() -> list[dict]:
    with TEST_ACCOUNTS_LOCK:
        if CLOUD_MODE:
            return cloud_store.read_app_accounts()
        if not TEST_ACCOUNTS_FILE.exists():
            return []
        try:
            data = json.loads(TEST_ACCOUNTS_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []


def write_test_accounts(accounts: list[dict]) -> None:
    with TEST_ACCOUNTS_LOCK:
        if CLOUD_MODE:
            cloud_store.write_app_accounts(accounts)
            return
        TEST_ACCOUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = TEST_ACCOUNTS_FILE.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(accounts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(TEST_ACCOUNTS_FILE)


def account_is_active(account: dict) -> bool:
    status = str(account.get("status") or "trial")
    if status == "lifetime":
        return True
    if status != "trial":
        return False
    try:
        expires = datetime.fromisoformat(str(account.get("trialEndsAt") or "").replace("Z", "+00:00"))
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires > datetime.now(timezone.utc)
    except ValueError:
        return False


def create_trial_account() -> tuple[dict, str]:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    accounts = read_test_accounts()
    existing_hashes = {str(item.get("keyHash") or "") for item in accounts}
    while True:
        raw = "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))
        hashed = login_key_hash(raw)
        if hashed not in existing_hashes:
            break
    now = datetime.now(timezone.utc)
    account = {
        "id": f"U-{secrets.token_hex(3).upper()}",
        "keyHash": hashed,
        "loginKey": raw,
        "keySuffix": raw[-4:],
        "status": "trial",
        "createdAt": now.isoformat(),
        "trialEndsAt": (now + timedelta(days=7)).isoformat(),
        "lastLoginAt": None,
        "aiEnabled": False,
        "aiUsage": {},
    }
    accounts.append(account)
    write_test_accounts(accounts)
    if CLOUD_MODE:
        cloud_store.write_portfolio(user_profile_id(account["id"]), {
            "holdings": [],
            "transactions": [],
            "realizedTrades": [],
            "history": [],
            "fx": {},
            "accountStartDate": None,
            "ledgerStartDate": None,
            "lastRefreshAt": None,
            "investmentPlan": "",
            "totalAssetsJPY": 0,
        })
    return account, raw


def ai_usage_day() -> str:
    return datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()


def account_ai_usage(account: dict) -> dict:
    usage = account.get("aiUsage") if isinstance(account.get("aiUsage"), dict) else {}
    today = ai_usage_day()
    if usage.get("date") != today:
        usage = {"date": today, "calendar": 0, "forecast": 0}
    calendar_used = max(0, int(usage.get("calendar") or 0))
    forecast_used = max(0, int(usage.get("forecast") or 0))
    return {
        "enabled": bool(account.get("aiEnabled", False)),
        "date": today,
        "limit": AI_DAILY_LIMIT,
        "calendarUsed": calendar_used,
        "calendarRemaining": max(0, AI_DAILY_LIMIT - calendar_used),
        "forecastUsed": forecast_used,
        "forecastRemaining": max(0, AI_DAILY_LIMIT - forecast_used),
    }


class AccountAIError(RuntimeError):
    def __init__(self, message: str, status: HTTPStatus):
        self.status = status
        super().__init__(message)


def reserve_account_ai_usage(user_id: str, category: str) -> dict:
    if category not in {"calendar", "forecast"}:
        raise ValueError("AI 使用类型不正确")
    with TEST_ACCOUNTS_LOCK:
        accounts = read_test_accounts()
        account = next((item for item in accounts if item.get("id") == user_id), None)
        if not account or not account_is_active(account):
            raise AccountAIError("账户不可用", HTTPStatus.FORBIDDEN)
        if not account.get("aiEnabled", False):
            raise AccountAIError("AI 功能尚未开通", HTTPStatus.FORBIDDEN)
        usage = account_ai_usage(account)
        used_key = f"{category}Used"
        remaining_key = f"{category}Remaining"
        if usage[remaining_key] <= 0:
            label = "日历分析" if category == "calendar" else "资产预测"
            raise AccountAIError(f"今天的{label}次数已用完，明天恢复", HTTPStatus.TOO_MANY_REQUESTS)
        account["aiUsage"] = {
            "date": usage["date"],
            "calendar": usage["calendarUsed"] + (1 if category == "calendar" else 0),
            "forecast": usage["forecastUsed"] + (1 if category == "forecast" else 0),
        }
        write_test_accounts(accounts)
        return account_ai_usage(account)


def refund_account_ai_usage(user_id: str, category: str) -> None:
    with TEST_ACCOUNTS_LOCK:
        accounts = read_test_accounts()
        account = next((item for item in accounts if item.get("id") == user_id), None)
        if not account:
            return
        usage = account_ai_usage(account)
        account["aiUsage"] = {
            "date": usage["date"],
            "calendar": max(0, usage["calendarUsed"] - (1 if category == "calendar" else 0)),
            "forecast": max(0, usage["forecastUsed"] - (1 if category == "forecast" else 0)),
        }
        write_test_accounts(accounts)


def signed_user_cookie(user_id: str) -> str:
    signature = hmac.new(ACCESS_TOKEN.encode(), user_id.encode(), hashlib.sha256).hexdigest()
    return f"{user_id}.{signature}"


def verify_user_cookie(value: str) -> str | None:
    try:
        user_id, signature = value.rsplit(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(signed_user_cookie(user_id), value):
        return None
    account = next((item for item in read_test_accounts() if item.get("id") == user_id), None)
    return user_id if account and account_is_active(account) else None


class ProfileConflictError(Exception):
    pass


def normalize_gold_quote_sources(data: dict) -> bool:
    """Keep gold holdings on the live international spot-price route."""
    changed = False
    for holding in data.get("holdings", []):
        if not isinstance(holding, dict) or str(holding.get("name") or "").strip() != "黄金":
            continue
        if holding.get("symbol") is not None:
            holding["symbol"] = None
            changed = True
        if holding.get("quoteSource") != "internationalGold":
            holding["quoteSource"] = "internationalGold"
            changed = True
        if holding.get("autoQuote") is not True:
            holding["autoQuote"] = True
            changed = True
    return changed


def read_friend_profile() -> dict | None:
    if CLOUD_MODE:
        return cloud_store.read_portfolio("friend")
    with FRIEND_PROFILE_LOCK:
        if not FRIEND_PROFILE_FILE.exists():
            return None
        with FRIEND_PROFILE_FILE.open(encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, dict) and isinstance(data.get("holdings"), list) else None


def read_friend_profile_core(recent_history_limit: int = 0) -> dict | None:
    if CLOUD_MODE:
        return cloud_store.read_portfolio_core("friend", recent_history_limit=recent_history_limit)
    data = read_friend_profile()
    if data is None:
        return None
    core = copy.deepcopy(data)
    history = core.get("history", [])
    core["history"] = history[-recent_history_limit:] if recent_history_limit else []
    return core


def read_profile_history(profile_id: str) -> list[dict]:
    if CLOUD_MODE:
        return cloud_store.read_history(profile_id)
    if profile_id == "friend":
        data = read_friend_profile()
    elif profile_id.startswith("user:"):
        data = read_account_profile(profile_id)
    else:
        data = read_data()
    return copy.deepcopy(data.get("history", [])) if data else []


def write_friend_profile(data: dict, expected_revision: int | None = None) -> dict:
    normalize_gold_quote_sources(data)
    if CLOUD_MODE:
        stale_history_days = data.pop("_staleHistoryDays", [])
        try:
            saved = cloud_store.write_portfolio("friend", data, expected_revision=expected_revision)
        except cloud_store.CloudConflictError as error:
            raise ProfileConflictError(str(error)) from error
        if stale_history_days:
            cloud_store.delete_history_days("friend", stale_history_days)
            stale_day_set = set(stale_history_days)
            saved["history"] = [
                item for item in saved.get("history", [])
                if item.get("date") not in stale_day_set
            ]
        return saved
    with FRIEND_PROFILE_LOCK:
        current_revision = 0
        if FRIEND_PROFILE_FILE.exists():
            try:
                current = json.loads(FRIEND_PROFILE_FILE.read_text(encoding="utf-8"))
                current_revision = int(current.get("_profileRevision") or 0)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                current_revision = 0
        if expected_revision is not None and expected_revision != current_revision:
            raise ProfileConflictError("朋友持仓已在另一台设备更新，请刷新页面后重试")
        saved = copy.deepcopy(data)
        saved["_profileRevision"] = current_revision + 1
        saved["_profileSavedAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
        FRIEND_PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary_file = FRIEND_PROFILE_FILE.with_suffix(".json.tmp")
        temporary_file.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary_file.replace(FRIEND_PROFILE_FILE)
        return saved


def user_profile_id(user_id: str) -> str:
    return f"user:{user_id}"


def read_account_profile(profile_id: str) -> dict | None:
    if profile_id == "friend":
        return read_friend_profile()
    if CLOUD_MODE:
        return cloud_store.read_portfolio(profile_id)
    path = TEST_USER_DATA_DIR / profile_id.removeprefix("user:") / "portfolio.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) and isinstance(data.get("holdings"), list) else None


def read_account_profile_core(profile_id: str, recent_history_limit: int = 0) -> dict | None:
    if profile_id == "friend":
        return read_friend_profile_core(recent_history_limit=recent_history_limit)
    if CLOUD_MODE:
        return cloud_store.read_portfolio_core(profile_id, recent_history_limit=recent_history_limit)
    data = read_account_profile(profile_id)
    if data is None:
        return None
    core = copy.deepcopy(data)
    history = core.get("history", [])
    core["history"] = history[-recent_history_limit:] if recent_history_limit else []
    return core


def write_account_profile(profile_id: str, data: dict, expected_revision: int | None = None) -> dict:
    if profile_id == "friend":
        return write_friend_profile(data, expected_revision=expected_revision)
    normalize_gold_quote_sources(data)
    if CLOUD_MODE:
        stale_history_days = data.pop("_staleHistoryDays", [])
        try:
            saved = cloud_store.write_portfolio(profile_id, data, expected_revision=expected_revision)
        except cloud_store.CloudConflictError as error:
            raise ProfileConflictError(str(error)) from error
        if stale_history_days:
            cloud_store.delete_history_days(profile_id, stale_history_days)
            stale_day_set = set(stale_history_days)
            saved["history"] = [
                item for item in saved.get("history", [])
                if item.get("date") not in stale_day_set
            ]
        return saved
    user_directory = TEST_USER_DATA_DIR / profile_id.removeprefix("user:")
    path = user_directory / "portfolio.json"
    current_revision = 0
    if path.exists():
        try:
            current_revision = int(json.loads(path.read_text(encoding="utf-8")).get("_profileRevision") or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            current_revision = 0
    if expected_revision is not None and expected_revision != current_revision:
        raise ProfileConflictError("持仓已在另一台设备更新，请刷新页面后重试")
    saved = copy.deepcopy(data)
    saved["_profileRevision"] = current_revision + 1
    saved["_profileSavedAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    user_directory.mkdir(parents=True, exist_ok=True)
    temporary_file = path.with_suffix(".json.tmp")
    temporary_file.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_file.replace(path)
    return saved


def friend_slow_quotes_due(data: dict) -> bool:
    now = datetime.now(timezone.utc)
    for holding in data.get("holdings", []):
        fund_id = holding.get("fundId") or FUND_IDS.get(holding.get("name"))
        smbc_code = holding.get("smbcFundCode") or smbc_fund_code(holding.get("name"))
        if not (fund_id or smbc_code or holding.get("quoteSource") == "rakutenGold"):
            continue
        updated_at = holding.get("quoteUpdatedAt")
        if not updated_at:
            return True
        try:
            updated = datetime.fromisoformat(str(updated_at).replace("Z", "+00:00"))
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            if (now - updated.astimezone(timezone.utc)).total_seconds() >= SLOW_QUOTE_INTERVAL_SECONDS:
                return True
        except ValueError:
            return True
    return False


def read_data() -> dict:
    if CLOUD_MODE:
        data = cloud_store.read_portfolio("owner")
        if not data:
            raise ValueError("云端持仓尚未建立")
        return data
    with DATA_LOCK:
        with DATA_FILE.open(encoding="utf-8") as file:
            data = json.load(file)
        changed = False
        if not isinstance(data.get("transactions"), list):
            data["transactions"] = []
            changed = True
        for transaction in data["transactions"]:
            original = (
                transaction.get("name"),
                transaction.get("account"),
                transaction.get("product"),
                transaction.get("fundId"),
            )
            normalize_historical_transaction(transaction)
            current = (
                transaction.get("name"),
                transaction.get("account"),
                transaction.get("product"),
                transaction.get("fundId"),
            )
            changed = changed or original != current
        transactions_by_id = {
            str(transaction.get("id")): transaction
            for transaction in data["transactions"]
            if transaction.get("id")
        }
        for trade in data.get("realizedTrades", []):
            transaction = transactions_by_id.get(str(trade.get("transactionId") or ""))
            if not transaction:
                continue
            for key in ("name", "symbol", "account", "product"):
                value = transaction.get(key)
                if value is not None and trade.get(key) != value:
                    trade[key] = value
                    changed = True
        for holding in data.get("holdings", []):
            if not holding.get("id"):
                holding["id"] = secrets.token_urlsafe(12)
                changed = True
        if changed:
            write_data(data)
        return data


def read_data_core(recent_history_limit: int = 0) -> dict:
    if CLOUD_MODE:
        data = cloud_store.read_portfolio_core("owner", recent_history_limit=recent_history_limit)
        if not data:
            raise ValueError("云端持仓尚未建立")
        return data
    data = copy.deepcopy(read_data())
    history = data.get("history", [])
    data["history"] = history[-recent_history_limit:] if recent_history_limit else []
    return data


def normalize_historical_transaction(transaction: dict) -> None:
    name = str(transaction.get("name") or "")
    symbol = str(transaction.get("symbol") or "").upper()
    day_text = transaction_date(transaction)
    if symbol == "TSLA" or name == "TSLA":
        transaction["name"] = "TSLA"
        transaction["symbol"] = "TSLA"
        transaction["account"] = "NISA"
        transaction["product"] = "美股"
        return
    if name == "NASDAQ100指数基金":
        is_emaxis = (
            (transaction.get("type") == "SELL" and abs(float(transaction.get("quantity") or 0) - 6881) < 0.01)
            or (day_text is not None and day_text <= "2024-06-04")
        )
        name = "eMAXIS NASDAQ100" if is_emaxis else "ニッセイNASDAQ100"
        transaction["name"] = name
    if name in FUND_IDS:
        transaction["fundId"] = FUND_IDS[name]
        transaction["account"] = "NISA" if name != "黄金" else "黄金"
        transaction["product"] = "基金" if name != "黄金" else "黄金"


def write_data(data: dict) -> dict:
    normalize_gold_quote_sources(data)
    if CLOUD_MODE:
        stale_history_days = data.pop("_staleHistoryDays", [])
        saved = cloud_store.write_portfolio("owner", data)
        if stale_history_days:
            cloud_store.delete_history_days("owner", stale_history_days)
            stale_day_set = set(stale_history_days)
            saved["history"] = [
                item for item in saved.get("history", [])
                if item.get("date") not in stale_day_set
            ]
        return saved
    with DATA_LOCK:
        temporary_file = DATA_FILE.with_suffix(".json.tmp")
        with temporary_file.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
        temporary_file.replace(DATA_FILE)
    return data


def compact_daily_ai_report(report: dict) -> dict:
    fields = ("analysisVersion", "date", "summary", "changeNature", "logicChanges", "actions", "generatedAt", "model")
    return {field: copy.deepcopy(report.get(field)) for field in fields if field in report}


def save_daily_ai_summary(profile_id: str, date_text: str, report: dict) -> dict:
    saved_report = compact_daily_ai_report(report)
    if CLOUD_MODE:
        last_error = None
        for _ in range(2):
            try:
                return cloud_store.write_daily_ai_summary(profile_id, date_text, saved_report, limit=60)
            except cloud_store.CloudConflictError as error:
                last_error = error
        raise ProfileConflictError(str(last_error or "日报保存冲突"))
    if profile_id == "friend":
        with FRIEND_PROFILE_LOCK:
            if not FRIEND_PROFILE_FILE.exists():
                raise ValueError("朋友持仓尚未建立")
            data = json.loads(FRIEND_PROFILE_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("朋友持仓数据格式不正确")
            summaries = data.get("dailyAiSummaries")
            summaries = copy.deepcopy(summaries) if isinstance(summaries, dict) else {}
            summaries[date_text] = saved_report
            data["dailyAiSummaries"] = {day: summaries[day] for day in sorted(summaries)[-60:]}
            temporary_file = FRIEND_PROFILE_FILE.with_suffix(".json.tmp")
            temporary_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary_file.replace(FRIEND_PROFILE_FILE)
        return saved_report
    data = read_data()
    summaries = data.get("dailyAiSummaries")
    summaries = copy.deepcopy(summaries) if isinstance(summaries, dict) else {}
    summaries[date_text] = saved_report
    data["dailyAiSummaries"] = {day: summaries[day] for day in sorted(summaries)[-60:]}
    write_data(data)
    return saved_report


def read_goal_settings(profile_id: str) -> dict | None:
    if CLOUD_MODE:
        return cloud_store.read_goal_settings(profile_id)
    if profile_id == "friend":
        path = FRIEND_GOAL_SIMULATOR_FILE
    elif profile_id.startswith("user:"):
        path = TEST_USER_DATA_DIR / profile_id.removeprefix("user:") / "goal-simulator.json"
    else:
        path = GOAL_SIMULATOR_FILE
    if not path.exists():
        return None
    settings = json.loads(path.read_text(encoding="utf-8"))
    return settings if isinstance(settings, dict) else None


def write_goal_settings(profile_id: str, settings: dict) -> dict:
    if CLOUD_MODE:
        return cloud_store.write_goal_settings(profile_id, settings)
    if profile_id == "friend":
        path = FRIEND_GOAL_SIMULATOR_FILE
    elif profile_id.startswith("user:"):
        path = TEST_USER_DATA_DIR / profile_id.removeprefix("user:") / "goal-simulator.json"
    else:
        path = GOAL_SIMULATOR_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = path.with_suffix(".tmp")
    temporary_file.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_file.replace(path)
    return settings


def save_goal_ai_result(profile_id: str, settings_snapshot: dict, forecast: dict, report: dict) -> dict:
    remote_settings = read_goal_settings(profile_id)
    settings = copy.deepcopy(remote_settings) if isinstance(remote_settings, dict) else copy.deepcopy(settings_snapshot)
    if not isinstance(settings.get("assetTypes"), list):
        settings = copy.deepcopy(settings_snapshot)
    forecast_by_id = {
        str(item.get("assetTypeId")): item
        for item in forecast.get("assetForecasts", [])
        if isinstance(item, dict) and item.get("assetTypeId") is not None
    }
    for asset in settings.get("assetTypes", []):
        if not isinstance(asset, dict):
            continue
        item = forecast_by_id.get(str(asset.get("id")))
        if not item:
            continue
        for target_field, source_fields in {
            "annualRate": ("baseRate", "annualRate"),
            "bearRate": ("bearRate",),
            "bullRate": ("bullRate",),
        }.items():
            value = next((item.get(field) for field in source_fields if item.get(field) is not None), None)
            try:
                numeric_value = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(numeric_value):
                asset[target_field] = max(-99, min(500, numeric_value))
    settings["aiAnalysis"] = {
        "forecast": copy.deepcopy(forecast),
        "report": copy.deepcopy(report),
    }
    settings["updatedAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    return write_goal_settings(profile_id, settings)


def yahoo_quote(symbol: str) -> dict:
    encoded_symbol = urllib.parse.quote(symbol, safe=".")
    payload = None
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        if symbol.endswith("=F"):
            interval = "1m"
        elif not symbol.endswith(".T"):
            # Yahoo's daily candle can leave the immediately preceding US
            # session empty while the next session is trading. Intraday bars
            # still contain that session's real close, so use them to avoid
            # accidentally calculating a two-session move.
            interval = "5m"
        else:
            interval = "1d"
        url = f"https://{host}/v8/finance/chart/{encoded_symbol}?range=5d&interval={interval}"
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
                payload = json.load(response)
            break
        except Exception as error:
            last_error = error
    if payload is None:
        raise last_error or ValueError("Yahoo Finance 行情暂时不可用")
    result = payload["chart"]["result"][0]
    quote = result["meta"]
    timestamps = result.get("timestamp") or []
    raw_closes = result["indicators"]["quote"][0]["close"]
    closes = [close for close in raw_closes if close is not None]
    latest_bar = next(
        ((int(timestamp), float(close)) for timestamp, close in reversed(list(zip(timestamps, raw_closes))) if close is not None),
        None,
    )
    regular_market_time = int(quote.get("regularMarketTime") or 0)
    if latest_bar and latest_bar[0] >= regular_market_time:
        market_time, price = latest_bar
    else:
        market_time = regular_market_time or (latest_bar[0] if latest_bar else None)
        price = quote.get("regularMarketPrice") or (closes[-1] if closes else None)
    if price is None:
        raise ValueError("没有可用的最新价格")
    market_timezone = ZoneInfo(result["meta"].get("exchangeTimezoneName", "UTC"))
    market_date = (
        datetime.fromtimestamp(market_time, market_timezone).date().isoformat()
        if market_time
        else None
    )
    dated_closes = [
        (
            datetime.fromtimestamp(timestamp, market_timezone).date().isoformat(),
            close,
        )
        for timestamp, close in zip(timestamps, raw_closes)
        if close is not None
    ]
    previous_candidates = [
        close
        for close_date, close in dated_closes
        if market_date is None or close_date < market_date
    ]
    regular_start = ((quote.get("currentTradingPeriod") or {}).get("regular") or {}).get("start")
    reference_date = datetime.fromtimestamp(regular_start, market_timezone).date().isoformat() if regular_start else None
    official_previous = quote.get("regularMarketPreviousClose") or quote.get("previousClose")
    if official_previous and reference_date == market_date:
        previous = official_previous
    elif symbol.endswith("=F"):
        previous = (
            quote.get("previousClose")
            or quote.get("regularMarketPreviousClose")
            or (previous_candidates[-1] if previous_candidates else None)
        )
    else:
        previous = (
            previous_candidates[-1]
            if previous_candidates
            else quote.get("regularMarketPreviousClose")
        )
    result_quote = {
        "price": price,
        "previousClose": previous,
        "currency": quote.get("currency"),
        "marketTime": market_time,
        "marketDate": market_date,
    }
    market_session = current_us_market_session()
    if not symbol.endswith(".T") and not symbol.endswith("=X") and not symbol.endswith("=F"):
        result_quote["marketSession"] = market_session
    with STREAM_QUOTE_CACHE_LOCK:
        stream_quote = copy.deepcopy(STREAM_QUOTE_CACHE.get(symbol) or {})
    received_at = stream_quote.get("receivedAt")
    try:
        received_time = datetime.fromisoformat(str(received_at).replace("Z", "+00:00"))
        stream_is_fresh = (datetime.now(timezone.utc) - received_time.astimezone(timezone.utc)).total_seconds() < 180
    except (TypeError, ValueError):
        stream_is_fresh = False
    if stream_is_fresh and stream_quote.get("session") == "regular":
        # Keep the validated intraday previous close; the stream's change
        # baseline can lag by an extra US session immediately after opening.
        result_quote.update({
            key: stream_quote[key]
            for key in ("price", "currency", "marketTime", "marketDate")
            if stream_quote.get(key) is not None
        })
    if previous:
        result_quote["previousClose"] = previous
        result_quote["changePct"] = (float(result_quote["price"]) / float(previous) - 1) * 100
    if (
        not symbol.endswith(".T")
        and not symbol.endswith("=X")
        and not symbol.endswith("=F")
        and market_session != "regular"
    ):
        try:
            result_quote.update(yahoo_extended_quote(symbol, float(result_quote["price"])))
        except Exception:
            pass
    return result_quote


def yahoo_extended_quote(symbol: str, regular_price: float) -> dict:
    current_session = current_us_market_session()
    if current_session == "regular":
        return {}
    encoded_symbol = urllib.parse.quote(symbol, safe=".")
    payload = None
    last_error = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = f"https://{host}/v8/finance/chart/{encoded_symbol}?range=1d&interval=1m&includePrePost=true"
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
                payload = json.load(response)
            break
        except Exception as error:
            last_error = error
    if payload is None:
        raise last_error or ValueError("Yahoo Finance 盘前盘后行情暂时不可用")
    result = payload["chart"]["result"][0]
    timestamps = result.get("timestamp") or []
    closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    latest = next(
        ((int(timestamp), float(close)) for timestamp, close in reversed(list(zip(timestamps, closes))) if close is not None),
        None,
    )
    if not latest:
        return {}
    market_time, extended_price = latest
    received_market_time = datetime.fromtimestamp(market_time, timezone.utc)
    extended_session = current_us_market_session(received_market_time)
    if extended_session not in {"pre", "post"}:
        return {}
    age_seconds = (datetime.now(timezone.utc) - received_market_time).total_seconds()
    maximum_age = 30 * 60 if current_session in {"pre", "post"} else EXTENDED_QUOTE_MAX_AGE_SECONDS
    if current_session in {"pre", "post"} and extended_session != current_session:
        return {}
    if not 0 <= age_seconds <= maximum_age:
        return {}
    return {
        "extendedPrice": extended_price,
        "extendedSession": extended_session,
        "extendedMarketTime": market_time,
        "extendedChangePct": (extended_price / regular_price - 1) * 100 if regular_price else 0,
        "extendedReceivedAt": received_market_time.isoformat(),
    }


def merge_extended_quote(previous_quote: dict, quote: dict) -> dict:
    if quote.get("extendedSession") in {"pre", "post"}:
        return quote
    if not should_preserve_extended_quote(previous_quote):
        return quote
    for key in ("extendedPrice", "extendedSession", "extendedMarketTime", "extendedChangePct", "extendedReceivedAt"):
        if key in previous_quote:
            quote[key] = previous_quote[key]
    return quote


def attach_gold_futures_quote(quote: dict, futures_quote: dict | None) -> dict:
    if not futures_quote:
        return quote
    futures_price = futures_quote.get("price")
    previous_futures = futures_quote.get("previousClose")
    quote["futuresUSDPerOunce"] = futures_price
    quote["previousFuturesUSDPerOunce"] = previous_futures
    quote["futuresMarketTime"] = futures_quote.get("marketTime")
    if futures_price and previous_futures:
        quote["futuresChangePct"] = (float(futures_price) / float(previous_futures) - 1) * 100
    return quote


def international_gold_futures_quote(usd_jpy: dict, futures_quote: dict) -> dict:
    futures_price = float(futures_quote.get("price") or 0)
    previous_futures = float(futures_quote.get("previousClose") or futures_price)
    current_fx = float(usd_jpy.get("price") or 0)
    previous_fx = float(usd_jpy.get("previousClose") or current_fx)
    if futures_price <= 0 or current_fx <= 0:
        raise ValueError("黄金期货或 USD/JPY 行情暂时不可用")
    price = futures_price * current_fx / TROY_OUNCE_GRAMS
    previous_close = previous_futures * previous_fx / TROY_OUNCE_GRAMS
    market_time = futures_quote.get("marketTime")
    market_date = futures_quote.get("marketDate")
    return {
        "price": price,
        "previousClose": previous_close,
        "changePct": (price / previous_close - 1) * 100 if previous_close else 0,
        "jpyChangePct": (price / previous_close - 1) * 100 if previous_close else 0,
        "currency": "JPY/g",
        "marketTime": market_time,
        "marketDate": market_date,
        "futuresUSDPerOunce": futures_price,
        "previousFuturesUSDPerOunce": previous_futures,
        "futuresChangePct": (futures_price / previous_futures - 1) * 100 if previous_futures else 0,
        "futuresMarketTime": market_time,
    }


def yahoo_japan_quote(symbol: str) -> dict:
    encoded_symbol = urllib.parse.quote(symbol, safe=".")
    url = f"https://finance.yahoo.co.jp/quote/{encoded_symbol}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept-Language": "ja-JP,ja;q=0.9",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
        page = response.read().decode("utf-8", errors="replace")

    return parse_yahoo_japan_quote(page, symbol)


def parse_yahoo_japan_quote(page: str, symbol: str, now: datetime | None = None) -> dict:
    marker = f'codeWithMarketExtension\\":\\"{symbol}\\"'
    marker_index = page.find(marker)
    if marker_index < 0:
        raise ValueError("Yahoo Japan 行情字段未找到")
    quote_segment = page[marker_index:marker_index + 3000]

    def field(name: str) -> str | None:
        match = re.search(rf'{re.escape(name)}\\":\{{\\"value\\":\\"([^\"]+)\\"', quote_segment)
        return match.group(1) if match else None

    def number(value: str | None) -> float | None:
        if value is None:
            return None
        normalized = (
            value.replace(",", "")
            .replace("+", "")
            .replace("−", "-")
            .replace("－", "-")
            .strip()
        )
        try:
            return float(normalized)
        except ValueError:
            return None

    price = number(field("price"))
    change = number(field("priceChange"))
    change_pct = number(field("priceChangeRate"))
    update_match = re.search(r'japanUpdateTime\\":\\"([^\"]+)\\"', quote_segment)
    delay_match = re.search(r'delayMinutes\\":(\d+)', quote_segment)
    if price is None or not update_match:
        raise ValueError("Yahoo Japan 最新价格解析失败")
    if delay_match and int(delay_match.group(1)) != 0:
        raise ValueError("Yahoo Japan 当前仅提供延迟行情")

    tokyo = ZoneInfo("Asia/Tokyo")
    current = (now or datetime.now(tokyo)).astimezone(tokyo)
    dated_price = re.search(
        r'totalPrice\\":\{[^{}]*?updateDateMeta\\":\\"([^"\\]+)', page
    )
    open_date_match = re.search(
        r'openPrice\\":\{[^{}]*?updateDateMeta\\":\\"(\d{4}-\d{2}-\d{2})T', page
    )
    market_date = dated_price.group(1)[:10] if dated_price else open_date_match.group(1) if open_date_match else None
    if not market_date:
        raise ValueError("Yahoo Japan 缺少可核实的交易日期")
    update_time = update_match.group(1)
    try:
        time_parts = [int(part) for part in update_time.split(":")]
        market_datetime = datetime(
            *date.fromisoformat(market_date).timetuple()[:3],
            time_parts[0],
            time_parts[1],
            time_parts[2] if len(time_parts) > 2 else 0,
            tzinfo=tokyo,
        )
        if market_datetime > current or market_datetime.weekday() >= 5 or market_datetime.hour < 9:
            raise ValueError("Yahoo Japan 交易时间无效")
        if current.date() == market_datetime.date() and current.hour < 9:
            raise ValueError("日股尚未开盘")
        market_time = int(market_datetime.timestamp())
    except (TypeError, ValueError):
        raise ValueError("Yahoo Japan 交易时间无法确认")

    previous = price - change if change is not None else None
    result_quote = {
        "price": price,
        "previousClose": previous,
        "currency": "JPY",
        "marketTime": market_time,
        "marketDate": market_date,
        "source": "Yahoo Japan Finance",
    }
    if change_pct is not None:
        result_quote["changePct"] = change_pct
    elif previous:
        result_quote["changePct"] = (price / previous - 1) * 100
    return result_quote


def google_japan_quote(symbol: str) -> dict:
    code = symbol.removesuffix(".T")
    url = f"https://www.google.com/finance/quote/{urllib.parse.quote(code)}:TYO?hl=ja"
    request = urllib.request.Request(
        url,
        headers={
            "Accept-Language": "ja-JP,ja;q=0.9",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
        page = response.read().decode("utf-8", errors="replace")
    quote_match = re.search(
        r'data-exchange="TYO"[^>]*data-currency-code="([^"]+)"[^>]*'
        r'data-last-price="([^"]+)"[^>]*data-last-normal-market-timestamp="(\d+)"',
        page,
    )
    previous_match = re.search(
        r'前日の終値.{0,900}?<div class="P6K39c">([^<]+)</div>',
        page,
    )
    def number(value: str) -> float:
        normalized = re.sub(r"[^0-9.\-−－]", "", value).replace("−", "-").replace("－", "-")
        return float(normalized)

    if quote_match and previous_match:
        currency, raw_price, raw_market_time = quote_match.groups()
        price = number(raw_price)
        previous = number(previous_match.group(1))
        market_time = int(raw_market_time)
        change_pct = (price / previous - 1) * 100 if previous else None
    else:
        data_match = re.search(
            rf'\["{re.escape(code)}","TYO"\],"[^"]*",0,"JPY",'
            r'\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)[^\]]*\],null,(-?[\d.]+),'
            r'.{0,400}?\[(\d{10})\],"Asia/Tokyo"',
            page,
        )
        if not data_match:
            raise ValueError("Google Finance 日股行情解析失败")
        raw_price, _raw_change, raw_change_pct, raw_previous, raw_market_time = data_match.groups()
        currency = "JPY"
        price = float(raw_price)
        previous = float(raw_previous)
        market_time = int(raw_market_time)
        change_pct = float(raw_change_pct)
    market_date = datetime.fromtimestamp(market_time, ZoneInfo("Asia/Tokyo")).date().isoformat()
    return {
        "price": price,
        "previousClose": previous,
        "currency": currency,
        "marketTime": market_time,
        "marketDate": market_date,
        "changePct": change_pct,
        "source": "Google Finance",
    }


def japan_stock_quote(symbol: str) -> dict:
    errors = []
    for quote_fetcher in (yahoo_japan_quote, google_japan_quote, yahoo_quote):
        try:
            return quote_fetcher(symbol)
        except Exception as error:
            errors.append(str(error))
    raise ValueError("；".join(errors))


def current_us_market_session(now: datetime | None = None) -> str:
    current = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York"))
    if current.weekday() >= 5:
        return "closed"
    minutes = current.hour * 60 + current.minute
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return "pre"
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return "regular"
    if 16 * 60 <= minutes < 20 * 60:
        return "post"
    return "closed"


def should_preserve_extended_quote(previous_quote: dict) -> bool:
    extended_session = previous_quote.get("extendedSession")
    extended_received = previous_quote.get("extendedReceivedAt")
    if extended_session not in {"pre", "post"} or not extended_received:
        return False
    try:
        received_at = datetime.fromisoformat(str(extended_received).replace("Z", "+00:00"))
        extended_age = (datetime.now(timezone.utc) - received_at).total_seconds()
    except (TypeError, ValueError):
        return False
    if not 0 <= extended_age <= EXTENDED_QUOTE_MAX_AGE_SECONDS:
        return False
    current_session = current_us_market_session()
    if current_session == "regular":
        return False
    if current_session in {"pre", "post"}:
        return current_session == extended_session
    return extended_session in {"pre", "post"}


def yahoo_history(symbol: str, start: date, end: date) -> dict[str, float]:
    encoded_symbol = urllib.parse.quote(symbol, safe=".^=")
    start_epoch = int(datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    end_epoch = int(datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp())
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded_symbol}?period1={start_epoch}&period2={end_epoch}&interval=1d"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        payload = json.load(response)
    result = payload["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    exchange_timezone = ZoneInfo(result["meta"].get("exchangeTimezoneName", "UTC"))
    return {
        datetime.fromtimestamp(timestamp, exchange_timezone).date().isoformat(): close
        for timestamp, close in zip(result["timestamp"], closes)
        if close is not None
    }


def read_json_url(url: str, timeout: int = 15) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
        return json.load(response)


def xaus_gold_history(start: date, end: date) -> dict[str, float]:
    with GOLD_CACHE_LOCK:
        if time.monotonic() >= GOLD_HISTORY_CACHE["expiresAt"]:
            payload = read_json_url("https://xaus.com/api/v1/history", timeout=20)
            GOLD_HISTORY_CACHE["prices"] = {
                str(point["d"]): float(point["c"])
                for point in payload.get("points", [])
                if point.get("d") and point.get("c") is not None
            }
            GOLD_HISTORY_CACHE["expiresAt"] = time.monotonic() + 6 * 60 * 60
        prices = dict(GOLD_HISTORY_CACHE["prices"])
    return {
        day: price
        for day, price in prices.items()
        if start.isoformat() <= day <= end.isoformat()
    }


def xaus_spot_payload() -> dict:
    with GOLD_CACHE_LOCK:
        if time.monotonic() >= GOLD_SPOT_CACHE["expiresAt"]:
            payload = read_json_url("https://xaus.com/api/v1/spot?compact=1")
            spot_price = float(payload.get("spot_usd_oz") or payload.get("xau", {}).get("price") or 0)
            if spot_price <= 0:
                raise ValueError("国际黄金现货价格暂时不可用")
            GOLD_SPOT_CACHE["payload"] = payload
            GOLD_SPOT_CACHE["expiresAt"] = time.monotonic() + 30
        return copy.deepcopy(GOLD_SPOT_CACHE["payload"])


def rakuten_fund_history(fund_id: str, start: date, end: date) -> dict[str, float]:
    url = f"https://www.rakuten-sec.co.jp/web/fund/detail/?ID={urllib.parse.quote(fund_id)}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        page = response.read().decode("utf-8", errors="ignore")
    series_match = re.search(
        r"name:\s*'基準価額'.*?data\s*:\s*\[(.*?)\]\s*\n\s*}\s*,",
        page,
        re.S,
    )
    if not series_match:
        raise ValueError("楽天証券ページから基準価額履歴を取得できませんでした")
    history = {}
    for timestamp, value in re.findall(r"\[(\d+),(null|-?[\d.]+)\]", series_match.group(1)):
        if value == "null":
            continue
        day = datetime.fromtimestamp(int(timestamp) / 1000, timezone.utc).date()
        if start <= day <= end:
            history[day.isoformat()] = float(value)
    return history


def normalized_fund_name(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"[\s\u200b-\u200d\ufeff]", "", text).replace("·", "・")


def smbc_fund_code(value: object) -> str | None:
    normalized = normalized_fund_name(value)
    direct = SMBC_FUND_CODES.get(normalized)
    if direct:
        return direct
    upper = normalized.upper()
    if "SMBC" not in upper and "三井住友" not in normalized:
        return None
    if "日経225" in upper:
        return "182709"
    if "MSCIコクサイ" in upper or "MSCI国際" in upper:
        return "182909"
    if "S&P500" in upper or "SP500" in upper:
        return "182809"
    return None


def smbc_fund_history(fund_code: str, start: date, end: date) -> dict[str, float]:
    url = f"https://www.smd-am.co.jp/fund/{urllib.parse.quote(fund_code)}/"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        page = response.read().decode("utf-8", errors="ignore")
    csv_match = re.search(r"window\.csvData\s*=\s*JSON\.parse\('(.+?)'\);", page, re.S)
    if not csv_match:
        raise ValueError("SMBC官方页面から基準価額履歴を取得できませんでした")
    rows = json.loads(csv_match.group(1))
    history = {}
    for row in rows[1:]:
        values = next(csv.reader([row]))
        if len(values) < 3:
            continue
        day_text = values[0].strip()
        try:
            day = date.fromisoformat(day_text)
            price = float(values[2].replace(",", ""))
        except (ValueError, TypeError):
            continue
        if start <= day <= end:
            history[day_text] = price
    if not history:
        raise ValueError("SMBC官方页面から対象期間の基準価額を取得できませんでした")
    return history


def smbc_fund_quote(fund_code: str) -> dict:
    end = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    history = smbc_fund_history(fund_code, end - timedelta(days=14), end)
    days = sorted(history)
    current_day = days[-1]
    previous_day = days[-2] if len(days) >= 2 else current_day
    return {
        "price": history[current_day],
        "previousClose": history[previous_day],
        "currency": "JPY",
        "marketDate": current_day,
        "marketTime": int(datetime.combine(date.fromisoformat(current_day), datetime.min.time(), ZoneInfo("Asia/Tokyo")).timestamp()),
    }


def product_type(holding: dict) -> str:
    if holding.get("name") == "黄金":
        return "黄金"
    if holding.get("name") == "预存款与现金":
        return "现金"
    if str(holding.get("symbol") or "").endswith(".T"):
        return "日股"
    if not holding.get("symbol") and holding.get("market") == "JP":
        return "基金"
    return "美股"


def account_type(holding: dict) -> str:
    return normalize_account_type(holding.get("account"))


def normalize_account_type(value: object) -> str:
    text = str(value or "").strip()
    if not text or text == "未设置":
        return "未设置"
    if "NISA" in text.upper():
        return "NISA"
    if "特定" in text:
        return "特定"
    if text == "一般" or "持股会" in text or "持株会" in text:
        return "一般"
    if text == "金" or "黄金" in text:
        return "黄金"
    return text


def holding_unit_scale(holding: dict) -> float:
    return 10000 if holding.get("fundId") or holding.get("name") in FUND_IDS or holding.get("smbcFundCode") or smbc_fund_code(holding.get("name")) else 1


def holding_uses_usd_quote(holding: dict, quote: dict | None = None) -> bool:
    quote = quote or holding.get("quote") or {}
    if quote.get("currency") == "USD":
        return True
    return (
        holding.get("market") == "US"
        and bool(holding.get("symbol"))
        and not holding.get("fundId")
        and holding.get("quoteSource") != "internationalGold"
    )


def normalize_holding_quote(holding: dict, quote: dict) -> dict:
    normalized = dict(quote or {})
    if holding_uses_usd_quote(holding, normalized) and not normalized.get("currency"):
        normalized["currency"] = "USD"
    return normalized


def normalize_holding_symbol(holding: dict) -> str | None:
    symbol = str(holding.get("symbol") or "").strip().upper()
    if holding.get("market") == "JP" and re.fullmatch(r"\d{4}", symbol):
        symbol = f"{symbol}.T"
    holding["symbol"] = symbol or None
    if holding["symbol"]:
        holding["autoQuote"] = True
    return holding["symbol"]


def transaction_date(transaction: dict) -> str | None:
    timestamp = str(transaction.get("timestamp") or transaction.get("date") or "")
    try:
        return date.fromisoformat(timestamp[:10]).isoformat()
    except ValueError:
        return None


def transaction_effective_date(transaction: dict, holding: dict) -> str | None:
    day_text = transaction_date(transaction)
    if not day_text or holding.get("market") != "US" or not holding.get("symbol"):
        return day_text
    return day_text


def transaction_flow_weight(transaction: dict) -> float:
    timestamp = str(transaction.get("timestamp") or "")
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Tokyo"))
    except ValueError:
        return 0.5
    elapsed = moment.hour * 3600 + moment.minute * 60 + moment.second
    return max(0, min(1, (86400 - elapsed) / 86400))


def transactions_for_holding(data: dict, holding: dict) -> list[dict]:
    holding_id = holding.get("id")
    return [
        transaction
        for transaction in data.get("transactions", [])
        if (
            holding_id
            and transaction.get("holdingId") == holding_id
        ) or (
            not transaction.get("holdingId")
            and transaction.get("name") == holding.get("name")
        )
    ]


def historical_holdings(data: dict) -> list[dict]:
    holdings = [copy.deepcopy(holding) for holding in data.get("holdings", [])]
    active_names = {str(holding.get("name") or "") for holding in holdings}
    active_ids = {str(holding.get("id")) for holding in holdings if holding.get("id")}
    grouped_transactions: dict[str, list[dict]] = {}
    for transaction in data.get("transactions", []):
        name = str(transaction.get("name") or "")
        holding_id = str(transaction.get("holdingId") or "")
        if not name or name in active_names or holding_id in active_ids or name == "交易税费":
            continue
        if not transaction.get("symbol") and not transaction.get("fundId") and name not in FUND_IDS:
            continue
        grouped_transactions.setdefault(name, []).append(transaction)
    for name, transactions in grouped_transactions.items():
        latest = max(transactions, key=lambda item: transaction_date(item) or "")
        units = sum(
            float(transaction.get("quantity") or 0) * (1 if transaction.get("type") == "BUY" else -1)
            for transaction in transactions
        )
        symbol = str(latest.get("symbol") or "")
        market = "US" if symbol and not symbol.endswith(".T") else "JP"
        holdings.append(
            {
                "name": name,
                "symbol": symbol or None,
                "market": market,
                "account": normalize_account_type(latest.get("account")),
                "product": str(latest.get("product") or ("美股" if market == "US" else "基金")),
                "units": max(units, 0),
                "buyPrice": 0,
                "fundId": latest.get("fundId") or FUND_IDS.get(name),
                "autoQuote": False,
                "historicalOnly": True,
            }
        )
    return holdings


def units_before_day(current_units: float, transactions: list[dict], day_text: str, holding: dict) -> float:
    units = current_units
    for transaction in transactions:
        trade_day = transaction_effective_date(transaction, holding)
        if not trade_day or trade_day < day_text:
            continue
        quantity = float(transaction.get("quantity") or 0)
        units += -quantity if transaction.get("type") == "BUY" else quantity
    return max(units, 0)


def transaction_unit_value_jpy(transaction: dict) -> float:
    price = float(transaction.get("price") or 0)
    exchange_rate = float(transaction.get("exchangeRate") or 1)
    unit_scale = float(transaction.get("unitScale") or 1)
    return price * exchange_rate / unit_scale


def holding_profit_date(holding: dict) -> str | None:
    quote = holding.get("quote", {})
    # One dashboard day combines that day's Japan session with the US session
    # opening that night and closing the following morning. Gold follows the
    # same New York session date as US holdings.
    is_us_session = holding.get("market") == "US" or holding.get("quoteSource") == "internationalGold"
    market_date = quote.get("marketDate")
    market_time = quote.get("marketTime")
    if holding.get("quoteSource") == "internationalGold" and market_date:
        try:
            gold_session_date = date.fromisoformat(str(market_date))
            if gold_session_date.weekday() == 6:
                gold_session_date += timedelta(days=1)
            elif gold_session_date.weekday() == 5:
                gold_session_date -= timedelta(days=1)
            return gold_session_date.isoformat()
        except ValueError:
            pass
    try:
        timestamp = int(float(market_time))
        if timestamp > 10_000_000_000:
            timestamp //= 1000
        if timestamp > 0:
            if is_us_session:
                session_day = datetime.fromtimestamp(timestamp, ZoneInfo("America/New_York")).date()
                return session_day.isoformat()
            return datetime.fromtimestamp(timestamp, ZoneInfo("Asia/Tokyo")).date().isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    if not market_date:
        return None
    try:
        return date.fromisoformat(market_date).isoformat()
    except ValueError:
        return None


def current_holding_value(data: dict, holding: dict) -> float:
    quote = holding.get("quote", {})
    units = holding.get("units")
    price = quote.get("price")
    if units is None or price is None:
        return holding.get("valueJPY", 0)
    divisor = holding_unit_scale(holding)
    if holding_uses_usd_quote(holding, quote):
        fx = data.get("fx", {}).get("USDJPY", {}).get("price")
        return price * units * fx if fx else holding.get("valueJPY", 0)
    return price * units / divisor


def current_holding_daily_profit(data: dict, holding: dict, target_date: date | None = None) -> float:
    quote = holding.get("quote", {})
    if target_date and holding_profit_date(holding) != target_date.isoformat():
        return 0
    units = float(holding.get("units") or 0)
    price = quote.get("price")
    previous = quote.get("previousClose")
    if price is None or previous is None:
        return 0
    divisor = holding_unit_scale(holding)
    if holding_uses_usd_quote(holding, quote):
        fx_quote = data.get("fx", {}).get("USDJPY", {})
        current_fx = fx_quote.get("price")
        previous_fx = fx_quote.get("previousClose") or current_fx
        if not current_fx:
            return 0
        current_unit_value = price * current_fx
        previous_unit_value = previous * previous_fx
    else:
        current_unit_value = price / divisor
        previous_unit_value = previous / divisor
    if not target_date:
        return units * (current_unit_value - previous_unit_value)
    target_text = target_date.isoformat()
    transactions = transactions_for_holding(data, holding)
    day_transactions = [item for item in transactions if transaction_effective_date(item, holding) == target_text]
    if not day_transactions:
        return units * (current_unit_value - previous_unit_value)
    bought = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "BUY")
    sold = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "SELL")
    opening_units = max(units - bought + sold, 0)
    profit = max(opening_units - sold, 0) * (current_unit_value - previous_unit_value)
    for transaction in day_transactions:
        quantity = float(transaction.get("quantity") or 0)
        trade_unit_value = transaction_unit_value_jpy(transaction)
        if holding.get("quoteSource") == "internationalGold":
            trade_unit_value = current_unit_value
        fee = float(transaction.get("fee") or 0)
        if transaction.get("type") == "BUY":
            profit += quantity * (current_unit_value - trade_unit_value) - fee
        else:
            profit += quantity * (trade_unit_value - previous_unit_value) - fee
    return profit


def current_holding_daily_fx_impact(data: dict, holding: dict, target_date: date | None = None) -> float:
    quote = holding.get("quote", {})
    if holding.get("market") != "US" or not holding.get("symbol") or not holding_uses_usd_quote(holding, quote):
        return 0
    if target_date and holding_profit_date(holding) != target_date.isoformat():
        return 0
    price = float(quote.get("price") or 0)
    units = float(holding.get("units") or 0)
    fx_quote = data.get("fx", {}).get("USDJPY", {})
    current_fx = float(fx_quote.get("price") or 0)
    previous_fx = float(fx_quote.get("previousClose") or current_fx)
    if price <= 0 or current_fx <= 0:
        return 0
    if not target_date:
        return units * price * (current_fx - previous_fx)
    target_text = target_date.isoformat()
    transactions = transactions_for_holding(data, holding)
    day_transactions = [item for item in transactions if transaction_effective_date(item, holding) == target_text]
    bought = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "BUY")
    sold = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "SELL")
    opening_units = max(units - bought + sold, 0)
    impact = max(opening_units - sold, 0) * price * (current_fx - previous_fx)
    for transaction in day_transactions:
        if transaction.get("type") != "BUY":
            continue
        transaction_fx = float(transaction.get("exchangeRate") or current_fx)
        impact += float(transaction.get("quantity") or 0) * price * (current_fx - transaction_fx)
    return impact


def grouped_holding_values(data: dict, value_getter) -> dict[str, dict[str, float]]:
    groups = {"product": {}, "account": {}, "holding": {}}
    for holding in data["holdings"]:
        value = value_getter(data, holding)
        for mode, key in (("product", product_type(holding)), ("account", account_type(holding))):
            groups[mode][key] = groups[mode].get(key, 0) + value
        groups["holding"][holding["name"]] = groups["holding"].get(holding["name"], 0) + value
    return groups


def current_portfolio_value(data: dict) -> float:
    return sum(current_holding_value(data, holding) for holding in data["holdings"])


def history_point_return_base(point: dict) -> float:
    profit = float(point.get("dailyProfitJPY") or 0)
    stored_return = point.get("dailyReturnRate")
    if stored_return is not None:
        rate = float(stored_return)
        if abs(rate) > 1e-12:
            inferred_base = profit / rate
            if inferred_base > 0:
                return inferred_base
    closing_value = float(point.get("totalNetAsset", point.get("totalAssetsJPY", 0)) or 0)
    cash_flow = float(point.get("netExternalCashFlowJPY") or 0)
    weighted_flow = float(point.get("weightedExternalCashFlowJPY") or 0)
    return max(closing_value - profit - cash_flow + weighted_flow, 0)


def aggregate_holding_daily_return(breakdown: dict) -> float | None:
    holding_points = list((breakdown.get("holding") or {}).values())
    if not holding_points:
        return None
    total_profit = sum(float(point.get("dailyProfitJPY") or 0) for point in holding_points)
    total_base = sum(history_point_return_base(point) for point in holding_points)
    return total_profit / total_base if total_base > 0 else None


def current_daily_profit(data: dict, target_date: date | None = None) -> float:
    return sum(current_holding_daily_profit(data, holding, target_date) for holding in data["holdings"])


def dashboard_trading_day(value: date | str | None) -> bool:
    try:
        parsed = value if isinstance(value, date) else date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return False
    return parsed.weekday() < 5


def dashboard_history(history: object) -> list[dict]:
    return [
        item for item in (history or [])
        if isinstance(item, dict) and dashboard_trading_day(item.get("date"))
    ]


def has_profit_for_date(data: dict, target_date: date) -> bool:
    target_text = target_date.isoformat()
    return any(holding_profit_date(holding) == target_text for holding in data["holdings"])


def current_snapshot_dates(data: dict, now: datetime | None = None) -> list[date]:
    current = now or datetime.now(timezone.utc)
    tokyo_today = current.astimezone(ZoneInfo("Asia/Tokyo")).date()
    new_york_today = current.astimezone(ZoneInfo("America/New_York")).date()
    snapshot_dates: set[date] = set()
    for holding in data.get("holdings", []):
        profit_day = holding_profit_date(holding)
        if not profit_day:
            continue
        try:
            parsed_day = date.fromisoformat(profit_day)
        except ValueError:
            continue
        if not dashboard_trading_day(parsed_day):
            continue
        uses_us_session = holding.get("market") == "US" or holding.get("quoteSource") == "internationalGold"
        if uses_us_session:
            new_york_now = current.astimezone(ZoneInfo("America/New_York"))
            is_international_gold = holding.get("quoteSource") == "internationalGold"
            if parsed_day == new_york_today and new_york_now.weekday() < 5 and (
                is_international_gold or (new_york_now.hour, new_york_now.minute) >= (9, 30)
            ):
                snapshot_dates.add(parsed_day)
        elif parsed_day == tokyo_today and (
            not str(holding.get("symbol") or "").endswith(".T")
            or (current.astimezone(ZoneInfo("Asia/Tokyo")).hour >= 9 and tokyo_today.weekday() < 5)
        ):
            snapshot_dates.add(parsed_day)
    return sorted(snapshot_dates)


def upsert_current_history_snapshot(data: dict, target_date: date) -> dict | None:
    if not has_profit_for_date(data, target_date):
        return None
    target_text = target_date.isoformat()
    updated_holdings = sorted({
        str(holding.get("name") or holding.get("symbol") or "")
        for holding in data.get("holdings", [])
        if holding_profit_date(holding) == target_text
        and str(holding.get("name") or holding.get("symbol") or "")
    })
    history = data.setdefault("history", [])
    existing = next((item for item in history if item.get("date") == target_text), {})
    previous = next((item for item in reversed(history) if item.get("date", "") < target_text), None)
    existing_holdings = existing.get("breakdown", {}).get("holding", {})

    def session_value(current_data: dict, holding: dict, field: str) -> float:
        quote_day = holding_profit_date(holding)
        saved = existing_holdings.get(holding.get("name"), {})
        if quote_day and quote_day > target_text and saved:
            return float(saved.get(field) or 0)
        if field == "totalAssetsJPY":
            return current_holding_value(current_data, holding)
        if field == "dailyFxImpactJPY":
            return current_holding_daily_fx_impact(current_data, holding, target_date)
        return current_holding_daily_profit(current_data, holding, target_date)

    updated_holdings = sorted(set(updated_holdings) | {
        holding["name"] for holding in data["holdings"]
        if (holding_profit_date(holding) or "") > target_text
        and holding.get("name") in existing_holdings
        and holding.get("name") in existing.get("updatedHoldings", existing_holdings)
    })
    asset_groups = grouped_holding_values(data, lambda current_data, holding: session_value(current_data, holding, "totalAssetsJPY"))
    profit_groups = grouped_holding_values(
        data,
        lambda current_data, holding: session_value(current_data, holding, "dailyProfitJPY"),
    )
    fx_groups = grouped_holding_values(
        data,
        lambda current_data, holding: session_value(current_data, holding, "dailyFxImpactJPY"),
    )
    daily_profit = sum(round(value) for value in profit_groups["holding"].values())
    daily_fx_impact = sum(round(value) for value in fx_groups["holding"].values())
    total_assets = sum(round(value) for value in asset_groups["holding"].values())
    flow_groups = {"product": {}, "account": {}, "holding": {}}
    weighted_flow_groups = {"product": {}, "account": {}, "holding": {}}
    net_flow = 0.0
    weighted_flow = 0.0
    for transaction in data.get("transactions", []):
        if transaction.get("annualizedOnly") or transaction_date(transaction) != target_text:
            continue
        flow = float(transaction.get("externalCashFlowJPY") or 0)
        weighted = flow * transaction_flow_weight(transaction)
        net_flow += flow
        weighted_flow += weighted
        for mode, key in (
            ("product", str(transaction.get("product") or "未设置")),
            ("account", str(transaction.get("account") or "未设置")),
            ("holding", str(transaction.get("name") or transaction.get("symbol") or "未设置")),
        ):
            flow_groups[mode][key] = flow_groups[mode].get(key, 0) + flow
            weighted_flow_groups[mode][key] = weighted_flow_groups[mode].get(key, 0) + weighted
    breakdown = {"product": {}, "account": {}, "holding": {}}
    previous_breakdown = previous.get("breakdown", {}) if previous else {}
    for mode in breakdown:
        keys = set(asset_groups[mode]) | set(profit_groups[mode]) | set(flow_groups[mode])
        for key in keys:
            group_assets = round(asset_groups[mode].get(key, 0))
            group_profit = round(profit_groups[mode].get(key, 0))
            group_flow = round(flow_groups[mode].get(key, 0))
            group_weighted_flow = weighted_flow_groups[mode].get(key, 0)
            opening_assets = group_assets - group_profit - group_flow
            return_base = opening_assets + group_weighted_flow
            daily_return = group_profit / return_base if return_base > 0 else 0
            previous_rate = previous_breakdown.get(mode, {}).get(key, {}).get("cumulativeReturnRate")
            cumulative_rate = (
                ((1 + float(previous_rate) / 100) * (1 + daily_return) - 1) * 100
                if previous_rate is not None else daily_return * 100
            )
            breakdown[mode][key] = {
                "dailyProfitJPY": group_profit,
                "dailyFxImpactJPY": round(fx_groups[mode].get(key, 0)),
                "totalAssetsJPY": group_assets,
                "totalNetAsset": group_assets,
                "netExternalCashFlowJPY": group_flow,
                "weightedExternalCashFlowJPY": group_weighted_flow,
                "dailyReturnRate": daily_return,
                "dailyProfitRate": daily_return,
                "cumulativeReturnRate": cumulative_rate,
            }
    daily_return = aggregate_holding_daily_return(breakdown)
    if daily_return is None:
        opening_assets = total_assets - daily_profit - round(net_flow)
        return_base = opening_assets + weighted_flow
        daily_return = daily_profit / return_base if return_base > 0 else 0
    previous_rate = previous.get("cumulativeReturnRate") if previous else None
    cumulative_rate = (
        ((1 + float(previous_rate) / 100) * (1 + daily_return) - 1) * 100
        if previous_rate is not None else daily_return * 100
    )
    snapshot = {
        **existing,
        "date": target_text,
        "dailyProfitJPY": daily_profit,
        "dailyFxImpactJPY": daily_fx_impact,
        "totalAssetsJPY": total_assets,
        "totalNetAsset": total_assets,
        "netExternalCashFlowJPY": round(net_flow),
        "weightedExternalCashFlowJPY": weighted_flow,
        "dailyReturnRate": daily_return,
        "dailyProfitRate": daily_return,
        "cumulativeReturnRate": cumulative_rate,
        "breakdown": breakdown,
        "updatedHoldings": updated_holdings,
        "estimated": False,
        "live": True,
    }
    history = [item for item in history if item.get("date") != target_text]
    history.append(snapshot)
    data["history"] = sorted(history, key=lambda item: item.get("date", ""))
    return snapshot


def backfill_history(data: dict, end: date) -> None:
    previous_live_history = {
        str(item.get("date")): item
        for item in data.get("history", [])
        if isinstance(item, dict) and item.get("date") and item.get("live")
    }
    start_text = data.get("accountStartDate")
    if not start_text:
        return
    try:
        start = date.fromisoformat(start_text)
    except ValueError:
        return
    if start > end:
        return
    history_start = start - timedelta(days=7)
    try:
        fx_history = yahoo_history("JPY=X", history_start, end)
    except Exception:
        return
    daily_profit: dict[str, float] = {}
    daily_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    daily_fx_impact: dict[str, float] = {}
    daily_fx_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    daily_flow: dict[str, float] = {}
    daily_weighted_flow: dict[str, float] = {}
    daily_flow_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    daily_weighted_flow_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    gold_daily_returns: dict[str, float] = {}
    daily_twr_profit: dict[str, float] = {}
    daily_twr_base: dict[str, float] = {}
    daily_twr_profit_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    daily_twr_base_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    history_holdings = historical_holdings(data)

    def add_profit(day_text: str, amount: float, holding: dict, fx_impact: float = 0) -> None:
        if start.isoformat() <= day_text <= end.isoformat():
            daily_profit[day_text] = daily_profit.get(day_text, 0) + amount
            daily_fx_impact[day_text] = daily_fx_impact.get(day_text, 0) + fx_impact
            day_groups = daily_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
            fx_groups = daily_fx_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
            for mode, key in (("product", product_type(holding)), ("account", account_type(holding))):
                day_groups[mode][key] = day_groups[mode].get(key, 0) + amount
                fx_groups[mode][key] = fx_groups[mode].get(key, 0) + fx_impact
            day_groups["holding"][holding["name"]] = day_groups["holding"].get(holding["name"], 0) + amount
            fx_groups["holding"][holding["name"]] = fx_groups["holding"].get(holding["name"], 0) + fx_impact

    def add_twr_values(day_text: str, profit: float, base: float, holding: dict) -> None:
        if base <= 0.01 or not start.isoformat() <= day_text <= end.isoformat():
            return
        daily_twr_profit[day_text] = daily_twr_profit.get(day_text, 0) + profit
        daily_twr_base[day_text] = daily_twr_base.get(day_text, 0) + base
        profit_groups = daily_twr_profit_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        base_groups = daily_twr_base_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        for mode, key in (
            ("product", product_type(holding)),
            ("account", account_type(holding)),
            ("holding", str(holding.get("name") or holding.get("symbol") or "未设置")),
        ):
            profit_groups[mode][key] = profit_groups[mode].get(key, 0) + profit
            base_groups[mode][key] = base_groups[mode].get(key, 0) + base

    for transaction in data.get("transactions", []):
        if transaction.get("annualizedOnly"):
            continue
        day_text = transaction_date(transaction)
        if not day_text or not start.isoformat() <= day_text <= end.isoformat():
            continue
        flow = float(transaction.get("externalCashFlowJPY") or 0)
        if transaction.get("name") == "交易税费":
            tax_holding = {
                "name": "交易税费",
                "symbol": None,
                "market": "US",
                "account": normalize_account_type(transaction.get("account")),
            }
            add_profit(day_text, -abs(flow), tax_holding)
            weighted_flow = flow * transaction_flow_weight(transaction)
            daily_flow[day_text] = daily_flow.get(day_text, 0) + flow
            daily_weighted_flow[day_text] = daily_weighted_flow.get(day_text, 0) + weighted_flow
            day_groups = daily_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
            weighted_groups = daily_weighted_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
            for mode, key in (
                ("product", "美股"),
                ("account", account_type(tax_holding)),
                ("holding", "交易税费"),
            ):
                day_groups[mode][key] = day_groups[mode].get(key, 0) + flow
                weighted_groups[mode][key] = weighted_groups[mode].get(key, 0) + weighted_flow
            continue
        daily_profit.setdefault(day_text, 0)
        daily_flow[day_text] = daily_flow.get(day_text, 0) + flow
        weighted_flow = flow * transaction_flow_weight(transaction)
        daily_weighted_flow[day_text] = daily_weighted_flow.get(day_text, 0) + weighted_flow
        active_holding = next(
            (
                holding
                for holding in history_holdings
                if (
                    transaction.get("holdingId")
                    and transaction.get("holdingId") == holding.get("id")
                ) or (
                    not transaction.get("holdingId")
                    and transaction.get("name") == holding.get("name")
                )
            ),
            None,
        )
        if active_holding is None:
            continue
        breakdown_flow = flow
        if active_holding.get("quoteSource") == "internationalGold":
            quantity = float(transaction.get("quantity") or 0)
            average_cost = float(active_holding.get("buyPrice") or 0)
            if quantity > 0 and average_cost > 0:
                breakdown_flow = quantity * average_cost
                if transaction.get("type") == "SELL":
                    breakdown_flow *= -1
        breakdown_weighted_flow = breakdown_flow * transaction_flow_weight(transaction)
        day_groups = daily_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        weighted_groups = daily_weighted_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        for mode, key in (
            ("product", product_type(active_holding)),
            ("account", account_type(active_holding)),
            ("holding", str(active_holding.get("name") or active_holding.get("symbol") or "未设置")),
        ):
            day_groups[mode][key] = day_groups[mode].get(key, 0) + breakdown_flow
            weighted_groups[mode][key] = weighted_groups[mode].get(key, 0) + breakdown_weighted_flow

    for trade in data.get("realizedTrades", []):
        if trade.get("kind") != "DIVIDEND":
            continue
        day_text = transaction_date(trade)
        amount = float(trade.get("realizedProfitJPY") or 0)
        if not day_text or amount == 0 or not start.isoformat() <= day_text <= end.isoformat():
            continue
        base_name = re.sub(r"\s*分红$", "", str(trade.get("name") or ""))
        dividend_holding = next(
            (holding for holding in history_holdings if holding.get("name") == base_name),
            {
                "name": base_name or "分红",
                "symbol": trade.get("symbol"),
                "market": "US" if trade.get("product") == "美股" else "JP",
                "account": normalize_account_type(trade.get("account")),
            },
        )
        add_profit(day_text, amount, dividend_holding)
        flow = -amount
        weighted_flow = flow * transaction_flow_weight(trade)
        daily_flow[day_text] = daily_flow.get(day_text, 0) + flow
        daily_weighted_flow[day_text] = daily_weighted_flow.get(day_text, 0) + weighted_flow
        day_groups = daily_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        weighted_groups = daily_weighted_flow_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        for mode, key in (
            ("product", product_type(dividend_holding)),
            ("account", account_type(dividend_holding)),
            ("holding", str(dividend_holding.get("name") or "分红")),
        ):
            day_groups[mode][key] = day_groups[mode].get(key, 0) + flow
            weighted_groups[mode][key] = weighted_groups[mode].get(key, 0) + weighted_flow

    for holding in history_holdings:
        current_units = float(holding.get("units") or 0)
        holding_transactions = transactions_for_holding(data, holding)
        if (current_units <= 0 and not holding_transactions) or holding["name"] == "预存款与现金":
            continue
        fund_id = holding.get("fundId") or FUND_IDS.get(holding.get("name"))
        smbc_code = holding.get("smbcFundCode") or smbc_fund_code(holding.get("name"))
        try:
            if fund_id:
                prices = rakuten_fund_history(fund_id, history_start, end)
            elif smbc_code:
                prices = smbc_fund_history(smbc_code, history_start, end)
            elif holding.get("quoteSource") == "rakutenGold":
                prices = rakuten_gold_history(history_start, end)
            elif holding.get("quoteSource") == "internationalGold":
                prices = xaus_gold_history(history_start, end)
            elif holding.get("symbol"):
                prices = yahoo_history(holding["symbol"], history_start, end)
            else:
                continue
        except Exception:
            continue
        dates = sorted(prices)
        for previous, current in zip(dates, dates[1:]):
            if fund_id or smbc_code:
                display_day = current
                previous_unit_value = prices[previous] / 10000
                current_unit_value = prices[current] / 10000
            elif holding.get("quoteSource") == "rakutenGold":
                display_day = current
                previous_unit_value = prices[previous]
                current_unit_value = prices[current]
            elif holding.get("quoteSource") == "internationalGold":
                if previous not in fx_history or current not in fx_history:
                    continue
                display_day = current
                previous_unit_value = prices[previous] * fx_history[previous] / TROY_OUNCE_GRAMS
                current_unit_value = prices[current] * fx_history[current] / TROY_OUNCE_GRAMS
            elif holding.get("market") == "US":
                if previous not in fx_history or current not in fx_history:
                    continue
                display_day = current
                previous_unit_value = prices[previous] * fx_history[previous]
                current_unit_value = prices[current] * fx_history[current]
            else:
                display_day = current
                previous_unit_value = prices[previous]
                current_unit_value = prices[current]
            if not dashboard_trading_day(display_day):
                continue
            opening_units = units_before_day(current_units, holding_transactions, display_day, holding)
            day_transactions = [item for item in holding_transactions if transaction_effective_date(item, holding) == display_day]
            bought = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "BUY")
            sold = sum(float(item.get("quantity") or 0) for item in day_transactions if item.get("type") == "SELL")
            if (
                holding.get("quoteSource") == "internationalGold"
                and max(opening_units - sold, 0) > 0.000001
                and previous_unit_value > 0
            ):
                gold_daily_returns[display_day] = current_unit_value / previous_unit_value - 1
            profit = max(opening_units - sold, 0) * (current_unit_value - previous_unit_value)
            fx_impact = 0.0
            if holding.get("market") == "US" and holding.get("symbol") and previous in fx_history and current in fx_history:
                fx_impact = max(opening_units - sold, 0) * prices[current] * (fx_history[current] - fx_history[previous])
            for transaction in day_transactions:
                quantity = float(transaction.get("quantity") or 0)
                trade_unit_value = transaction_unit_value_jpy(transaction)
                transaction_flow = abs(float(transaction.get("externalCashFlowJPY") or 0))
                if quantity > 0 and transaction_flow > 0:
                    trade_unit_value = transaction_flow / quantity
                if holding.get("quoteSource") == "internationalGold":
                    trade_unit_value = current_unit_value
                fee = float(transaction.get("fee") or 0)
                if transaction.get("type") == "BUY":
                    profit += quantity * (current_unit_value - trade_unit_value) - fee
                    if holding.get("market") == "US" and holding.get("symbol"):
                        transaction_fx = float(transaction.get("exchangeRate") or fx_history.get(current) or 0)
                        fx_impact += quantity * prices[current] * (fx_history[current] - transaction_fx)
                else:
                    profit += quantity * (trade_unit_value - previous_unit_value)
            add_twr_values(
                display_day,
                profit,
                max(opening_units, 0) * previous_unit_value,
                holding,
            )
            add_profit(display_day, profit, holding, fx_impact)
    if not daily_profit:
        return
    for holding in data.get("holdings", []):
        day_text = holding_profit_date(holding)
        if not day_text or not start.isoformat() <= day_text <= end.isoformat():
            continue
        target_day = date.fromisoformat(day_text)
        current_profit = current_holding_daily_profit(data, holding, target_day)
        current_fx_impact = current_holding_daily_fx_impact(data, holding, target_day)
        if holding.get("quoteSource") == "internationalGold":
            quote = holding.get("quote", {})
            current_price = float(quote.get("price") or 0)
            previous_price = float(quote.get("previousClose") or 0)
            if current_price > 0 and previous_price > 0 and float(holding.get("units") or 0) > 0:
                gold_daily_returns[day_text] = current_price / previous_price - 1
        profit_groups = daily_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        fx_groups = daily_fx_breakdown.setdefault(day_text, {"product": {}, "account": {}, "holding": {}})
        holding_key = str(holding.get("name") or holding.get("symbol") or "未设置")
        previous_profit = float(profit_groups["holding"].get(holding_key, 0))
        previous_fx_impact = float(fx_groups["holding"].get(holding_key, 0))
        profit_delta = current_profit - previous_profit
        fx_delta = current_fx_impact - previous_fx_impact
        daily_profit[day_text] = daily_profit.get(day_text, 0) + profit_delta
        daily_fx_impact[day_text] = daily_fx_impact.get(day_text, 0) + fx_delta
        for mode, key in (
            ("product", product_type(holding)),
            ("account", account_type(holding)),
            ("holding", holding_key),
        ):
            profit_groups[mode][key] = profit_groups[mode].get(key, 0) + profit_delta
            fx_groups[mode][key] = fx_groups[mode].get(key, 0) + fx_delta
    benchmark_returns: dict[str, dict[str, float]] = {
        "sp500": {},
        "nasdaq100": {},
        "topix": {},
    }

    def add_us_benchmark(benchmark_id: str, symbol: str) -> None:
        prices = yahoo_history(symbol, history_start, end)
        price_dates = sorted(prices)
        for previous, current in zip(price_dates, price_dates[1:]):
            if previous not in fx_history or current not in fx_history:
                continue
            display_day = current
            if start.isoformat() <= display_day <= end.isoformat():
                benchmark_returns[benchmark_id][display_day] = (
                    prices[current] * fx_history[current]
                    / (prices[previous] * fx_history[previous]) - 1
                )

    def add_jpy_benchmark(benchmark_id: str, prices: dict[str, float]) -> None:
        price_dates = sorted(prices)
        for previous, current in zip(price_dates, price_dates[1:]):
            if start.isoformat() <= current <= end.isoformat():
                benchmark_returns[benchmark_id][current] = prices[current] / prices[previous] - 1

    try:
        add_us_benchmark("sp500", "^GSPC")
    except Exception:
        pass
    try:
        add_us_benchmark("nasdaq100", "^NDX")
    except Exception:
        pass
    try:
        add_jpy_benchmark("topix", rakuten_fund_history(TOPIX_BENCHMARK_FUND_ID, history_start, end))
    except Exception:
        pass
    running_total = current_portfolio_value(data)
    running_groups = grouped_holding_values(data, current_holding_value)
    historical = []
    for day in reversed(sorted(daily_profit)):
        profit = round(daily_profit[day])
        cash_flow = round(daily_flow.get(day, 0))
        weighted_cash_flow = daily_weighted_flow.get(day, 0)
        day_groups = daily_breakdown.get(day, {"product": {}, "account": {}, "holding": {}})
        fx_groups = daily_fx_breakdown.get(day, {"product": {}, "account": {}, "holding": {}})
        flow_groups = daily_flow_breakdown.get(day, {"product": {}, "account": {}, "holding": {}})
        weighted_flow_groups = daily_weighted_flow_breakdown.get(day, {"product": {}, "account": {}, "holding": {}})
        breakdown = {"product": {}, "account": {}, "holding": {}}
        for mode in breakdown:
            keys = set(running_groups[mode]) | set(day_groups[mode]) | set(flow_groups[mode])
            for key in keys:
                group_profit = round(day_groups[mode].get(key, 0))
                group_flow = round(flow_groups[mode].get(key, 0))
                group_weighted_flow = weighted_flow_groups[mode].get(key, 0)
                breakdown[mode][key] = {
                    "dailyProfitJPY": group_profit,
                    "dailyFxImpactJPY": round(fx_groups[mode].get(key, 0)),
                    "totalAssetsJPY": round(running_groups[mode].get(key, 0)),
                    "totalNetAsset": round(running_groups[mode].get(key, 0)),
                    "netExternalCashFlowJPY": group_flow,
                    "weightedExternalCashFlowJPY": group_weighted_flow,
                }
                running_groups[mode][key] = running_groups[mode].get(key, 0) - group_profit - group_flow
        historical.append(
            {
                "date": day,
                "dailyProfitJPY": profit,
                "dailyFxImpactJPY": round(daily_fx_impact.get(day, 0)),
                "totalAssetsJPY": round(running_total),
                "totalNetAsset": round(running_total),
                "netExternalCashFlowJPY": cash_flow,
                "weightedExternalCashFlowJPY": weighted_cash_flow,
                "breakdown": breakdown,
                "estimated": True,
            }
        )
        running_total -= profit + cash_flow
    historical = list(reversed(historical))
    for mode in ("product", "account", "holding"):
        keys = {
            key
            for record in historical
            for key in record.get("breakdown", {}).get(mode, {})
        }
        for key in keys:
            points = [
                (record, record.get("breakdown", {}).get(mode, {}).get(key))
                for record in historical
                if record.get("breakdown", {}).get(mode, {}).get(key) is not None
            ]
            first_activity_index = next(
                (
                    index
                    for index, (_, point) in enumerate(points)
                    if abs(float(point.get("dailyProfitJPY") or 0)) > 0.01
                    or abs(float(point.get("netExternalCashFlowJPY") or 0)) > 0.01
                ),
                None,
            )
            starts_from_zero = (
                first_activity_index is not None
                and float(points[first_activity_index][1].get("netExternalCashFlowJPY") or 0) > 0
            )
            running_value = None
            for index, (_, point) in enumerate(points):
                if starts_from_zero and index < first_activity_index:
                    point["totalAssetsJPY"] = 0
                    point["totalNetAsset"] = 0
                    continue
                profit = float(point.get("dailyProfitJPY") or 0)
                cash_flow = float(point.get("netExternalCashFlowJPY") or 0)
                reverse_closing = float(point.get("totalAssetsJPY") or 0)
                if running_value is None:
                    if starts_from_zero and index == first_activity_index:
                        running_value = max(reverse_closing - profit - cash_flow, 0)
                    elif not reverse_closing and not profit and not cash_flow:
                        point["totalAssetsJPY"] = 0
                        point["totalNetAsset"] = 0
                        continue
                    else:
                        running_value = max(reverse_closing - profit - cash_flow, 0)
                running_value = max(running_value + profit + cash_flow, 0)
                point["totalAssetsJPY"] = round(running_value)
                point["totalNetAsset"] = round(running_value)
    if historical:
        benchmark_total = float(historical[0]["totalAssetsJPY"])
        transaction_days = [transaction_date(item) for item in data.get("transactions", [])]
        performance_start = data.get("ledgerStartDate") or min((day for day in transaction_days if day), default=None)
        cumulative_growth = 1.0
        group_growth: dict[str, dict[str, float]] = {"product": {}, "account": {}, "holding": {}}
        group_started: dict[str, set[str]] = {"product": set(), "account": set(), "holding": set()}
        for index, record in enumerate(historical):
            for mode, values in record["breakdown"].items():
                for key, point in values.items():
                    group_opening = (
                        float(point["totalNetAsset"])
                        - float(point["dailyProfitJPY"])
                        - float(point["netExternalCashFlowJPY"])
                    )
                    group_return_base = group_opening + float(point.get("weightedExternalCashFlowJPY") or 0)
                    group_profit_rate = float(point["dailyProfitJPY"]) / group_return_base if group_return_base > 0 else 0
                    group_return = group_profit_rate
                    twr_base = daily_twr_base_breakdown.get(record["date"], {}).get(mode, {}).get(key, 0)
                    if twr_base > 0:
                        twr_profit = daily_twr_profit_breakdown.get(record["date"], {}).get(mode, {}).get(key, 0)
                        group_return = twr_profit / twr_base
                    if (
                        (mode == "product" and key == "黄金")
                        or (mode == "account" and key == "黄金")
                        or (mode == "holding" and key == "黄金")
                    ):
                        group_return = gold_daily_returns.get(record["date"], group_return)
                    has_activity = (
                        abs(float(point.get("totalNetAsset") or 0)) > 0.01
                        or abs(float(point.get("dailyProfitJPY") or 0)) > 0.01
                        or abs(float(point.get("netExternalCashFlowJPY") or 0)) > 0.01
                        or twr_base > 0
                    )
                    if has_activity:
                        group_started[mode].add(key)
                    point["dailyProfitRate"] = group_profit_rate if key in group_started[mode] else None
                    point["dailyReturnRate"] = group_return if key in group_started[mode] else None
                    if performance_start and record["date"] >= performance_start and key in group_started[mode]:
                        group_growth[mode][key] = group_growth[mode].get(key, 1.0) * (1 + group_return)
                        point["cumulativeReturnRate"] = (group_growth[mode][key] - 1) * 100
                    else:
                        point["cumulativeReturnRate"] = None
            opening_assets = (
                float(record["totalNetAsset"])
                - float(record["dailyProfitJPY"])
                - float(record["netExternalCashFlowJPY"])
            )
            return_base = opening_assets + float(record.get("weightedExternalCashFlowJPY") or 0)
            record["dailyProfitRate"] = float(record["dailyProfitJPY"]) / return_base if return_base > 0 else 0
            daily_return = aggregate_holding_daily_return(record["breakdown"])
            if daily_return is None:
                daily_return = record["dailyProfitRate"]
            record["dailyReturnRate"] = daily_return
            if performance_start and record["date"] >= performance_start:
                cumulative_growth *= 1 + daily_return
                record["cumulativeReturnRate"] = (cumulative_growth - 1) * 100
            else:
                record["cumulativeReturnRate"] = None
            record["benchmarkReturns"] = {
                benchmark_id: values.get(record["date"], 0)
                for benchmark_id, values in benchmark_returns.items()
            }
            benchmark_return = record["benchmarkReturns"]["sp500"]
            if index == 0:
                benchmark_profit = benchmark_total * benchmark_return / (1 + benchmark_return)
            else:
                benchmark_profit = benchmark_total * benchmark_return
                benchmark_total += benchmark_profit
            record["sp500DailyProfitJPY"] = round(benchmark_profit)
            record["sp500BenchmarkJPY"] = round(benchmark_total)
            record["sp500Return"] = benchmark_return
    data["history"] = historical
    rebuilt_days = {str(item.get("date")) for item in historical if item.get("date")}
    stale_live_days = sorted(set(previous_live_history) - rebuilt_days)
    if stale_live_days:
        data["_staleHistoryDays"] = stale_live_days
    else:
        data.pop("_staleHistoryDays", None)


def rakuten_fund_quote(fund_id: str) -> dict:
    url = f"https://www.rakuten-sec.co.jp/web/fund/detail/?ID={urllib.parse.quote(fund_id)}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=12, context=context) as response:
        page = response.read().decode("utf-8", errors="ignore")
    text = re.sub(r"<[^>]+>", " ", page)
    text = re.sub(r"\s+", " ", text)
    value_match = re.search(r"基準価額\s*\|?\s*([\d,]+)\s*円", text)
    change_match = re.search(r"前日比\s*([+-]?[\d,]+)\s*円", text)
    if not value_match:
        raise ValueError("楽天証券ページから基準価額を取得できませんでした")
    price = float(value_match.group(1).replace(",", ""))
    change = float(change_match.group(1).replace(",", "")) if change_match else 0
    series_match = re.search(
        r"name:\s*'基準価額'.*?data\s*:\s*\[(.*?)\]\s*\n\s*}\s*,",
        page,
        re.S,
    )
    market_date = None
    if series_match:
        timestamps = [
            int(timestamp)
            for timestamp, value in re.findall(r"\[(\d+),(null|-?[\d.]+)\]", series_match.group(1))
            if value != "null"
        ]
        if timestamps:
            market_date = datetime.fromtimestamp(max(timestamps) / 1000, timezone.utc).date().isoformat()
    return {
        "price": price,
        "previousClose": price - change,
        "currency": "JPY",
        "marketTime": None,
        "marketDate": market_date,
    }


def rakuten_gold_public_page(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=15, context=context) as response:
        return response.read().decode("euc_jp", errors="ignore")


def rakuten_gold_month(year: int, month: int) -> dict[str, float]:
    query = urllib.parse.urlencode(
        {
            "eventType": "visitorInit",
            "CommodityCode": "101",
            "searchYear": year,
            "searchMonth": f"{month:02d}",
        }
    )
    page = rakuten_gold_public_page(
        f"https://member.rakuten-sec.co.jp/app/info_gold_timeseries_visitor.do?{query}"
    )
    prices = {}
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        day_match = re.search(r"(\d{4})/(\d{2})/(\d{2})", row)
        if not day_match:
            continue
        values = re.findall(
            r'<td[^>]*class="align-R"[^>]*>\s*([\d,]+(?:\.\d+)?)\s*</td>',
            row,
            re.S,
        )
        if len(values) < 9:
            continue
        day = date(*(int(part) for part in day_match.groups()))
        prices[day.isoformat()] = float(values[-1].replace(",", ""))
    return prices


def rakuten_gold_history(start: date, end: date) -> dict[str, float]:
    try:
        with GOLD_HISTORY_FILE.open(encoding="utf-8") as file:
            cache = json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}
    months = []
    cursor = date(start.year, start.month, 1)
    final_month = date(end.year, end.month, 1)
    while cursor <= final_month:
        months.append((cursor.year, cursor.month))
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    current_key = f"{end.year:04d}-{end.month:02d}"
    refresh_months = [
        (year, month)
        for year, month in months
        if f"{year:04d}-{month:02d}" not in cache or f"{year:04d}-{month:02d}" == current_key
    ]
    if refresh_months:
        with ThreadPoolExecutor(max_workers=min(4, len(refresh_months))) as executor:
            pending = {
                executor.submit(rakuten_gold_month, year, month): (year, month)
                for year, month in refresh_months
            }
            for future in as_completed(pending):
                year, month = pending[future]
                try:
                    prices = future.result()
                except Exception:
                    continue
                if prices:
                    cache[f"{year:04d}-{month:02d}"] = prices
        with GOLD_HISTORY_FILE.open("w", encoding="utf-8") as file:
            json.dump(cache, file, ensure_ascii=False, indent=2)
            file.write("\n")
    history = {}
    for year, month in months:
        history.update(cache.get(f"{year:04d}-{month:02d}", {}))
    return {
        day: price
        for day, price in history.items()
        if start.isoformat() <= day <= end.isoformat()
    }


def rakuten_gold_quote() -> dict:
    page = rakuten_gold_public_page(
        "https://member.rakuten-sec.co.jp/app/info_gold_price_visitor.do?eventType=visitorInit"
    )
    gold_match = re.search(
        r'<span class="doc-02">\s*金\s*</span>.*?'
        r'<span class="doc-02">([\d,]+(?:\.\d+)?)円/g</span>.*?'
        r'<span class="doc-02">([\d,]+(?:\.\d+)?)円/g</span>.*?'
        r'（(\d{2}/\d{2})\s+(\d{2}:\d{2})）',
        page,
        re.S,
    )
    if not gold_match:
        raise ValueError("楽天証券ページから金の買取価格を取得できませんでした")
    price = float(gold_match.group(2).replace(",", ""))
    now = datetime.now(ZoneInfo("Asia/Tokyo"))
    market_datetime = datetime.strptime(
        f"{now.year}/{gold_match.group(3)} {gold_match.group(4)}",
        "%Y/%m/%d %H:%M",
    ).replace(tzinfo=ZoneInfo("Asia/Tokyo"))
    if market_datetime.date() > now.date() + timedelta(days=1):
        market_datetime = market_datetime.replace(year=market_datetime.year - 1)
    history = rakuten_gold_history(market_datetime.date() - timedelta(days=14), market_datetime.date())
    previous_dates = [day for day in history if day < market_datetime.date().isoformat()]
    if not previous_dates:
        previous_dates = [day for day in history if day <= market_datetime.date().isoformat()]
    if not previous_dates:
        raise ValueError("楽天証券ページから金の前日価格を取得できませんでした")
    previous = history[max(previous_dates)]
    return {
        "price": price,
        "previousClose": previous,
        "currency": "JPY/g",
        "marketTime": int(market_datetime.timestamp()),
        "marketDate": market_datetime.date().isoformat(),
    }


def international_gold_quote(
    usd_jpy: dict,
    previous_quote: dict | None = None,
    spot_payload: dict | None = None,
) -> dict:
    payload = spot_payload or xaus_spot_payload()
    spot_price = float(payload.get("spot_usd_oz") or payload["xau"]["price"])
    price_as_of = str(payload.get("price_as_of") or payload.get("updated_at") or "")
    try:
        source_datetime = datetime.fromisoformat(price_as_of.replace("Z", "+00:00"))
    except ValueError:
        source_datetime = datetime.now(timezone.utc)
    previous_quote = previous_quote or {}
    session_date = source_datetime.astimezone(ZoneInfo("America/New_York")).date()
    if session_date.weekday() == 6:
        session_date += timedelta(days=1)
    elif session_date.weekday() == 5:
        session_date -= timedelta(days=1)
    session_date_text = session_date.isoformat()
    reusable_previous_spot = float(previous_quote.get("previousSpotUSDPerOunce") or 0)
    if previous_quote.get("marketDate") == session_date_text and reusable_previous_spot > 0:
        previous_spot = reusable_previous_spot
        market_date = session_date_text
    else:
        history = xaus_gold_history(session_date - timedelta(days=14), session_date)
        history_dates = sorted(history)
        if not history_dates:
            raise ValueError("国际黄金前一交易日价格暂时不可用")
        previous_dates = [day for day in history_dates if day < session_date_text]
        previous_day = previous_dates[-1] if previous_dates else history_dates[-1]
        previous_spot = history[previous_day]
        market_date = session_date_text
    current_fx = float(usd_jpy.get("price") or 0)
    previous_fx = float(usd_jpy.get("previousClose") or current_fx)
    if current_fx <= 0:
        raise ValueError("USD/JPY 行情暂时不可用")
    price = spot_price * current_fx / TROY_OUNCE_GRAMS
    previous_close = previous_spot * previous_fx / TROY_OUNCE_GRAMS
    jpy_change_pct = (price / previous_close - 1) * 100 if previous_close else 0
    return {
        "price": price,
        "previousClose": previous_close,
        "changePct": jpy_change_pct,
        "jpyChangePct": jpy_change_pct,
        "spotChangePct": (spot_price / previous_spot - 1) * 100 if previous_spot else 0,
        "currency": "JPY/g",
        "marketTime": int(source_datetime.timestamp()),
        "marketDate": market_date,
        "spotUSDPerOunce": spot_price,
        "previousSpotUSDPerOunce": previous_spot,
        "priceAsOf": source_datetime.isoformat(),
    }


def quote_status(state: str, attempted_at: str, *, error: str | None = None, slow: bool = False) -> dict:
    status = {
        "state": state,
        "lastAttemptAt": attempted_at,
        "staleAfterSeconds": SLOW_QUOTE_INTERVAL_SECONDS * 2 if slow else LIVE_QUOTE_INTERVAL_SECONDS * 6,
    }
    if state == "ok":
        status["lastSuccessAt"] = attempted_at
    if error:
        status["message"] = error
    return status


def refresh_quote_tier(data: dict, *, include_fast: bool, include_slow: bool) -> tuple[dict, list[str]]:
    attempted_at = datetime.now(timezone.utc).isoformat()
    errors: list[str] = []
    successful_updates = 0
    yahoo_symbols: set[str] = set()
    normalize_gold_quote_sources(data)
    for holding in data.get("holdings", []):
        normalize_holding_symbol(holding)
    if include_fast:
        yahoo_symbols.add("JPY=X")
        if any(holding.get("quoteSource") == "internationalGold" for holding in data.get("holdings", [])):
            yahoo_symbols.add("GC=F")
        for holding in data.get("holdings", []):
            if holding.get("symbol") and holding.get("autoQuote", False) and not holding.get("fundId"):
                yahoo_symbols.add(str(holding["symbol"]))
    yahoo_results: dict[str, dict] = {}
    yahoo_errors: dict[str, str] = {}
    gold_spot_payload = None
    if yahoo_symbols:
        with ThreadPoolExecutor(max_workers=min(8, len(yahoo_symbols))) as executor:
            pending = {
                executor.submit(japan_stock_quote if symbol.endswith(".T") else yahoo_quote, symbol): symbol
                for symbol in yahoo_symbols
            }
            for future in as_completed(pending):
                symbol = pending[future]
                try:
                    yahoo_results[symbol] = future.result()
                except Exception as error:
                    yahoo_errors[symbol] = str(error)
    if include_fast:
        fx_quote = yahoo_results.get("JPY=X")
        if fx_quote:
            fx_quote["receivedAt"] = attempted_at
            fx_quote["source"] = "Yahoo Finance"
            data.setdefault("fx", {})["USDJPY"] = fx_quote
            data.setdefault("quoteHealth", {})["USDJPY"] = quote_status("ok", attempted_at)
            successful_updates += 1
        elif "JPY=X" in yahoo_errors:
            error = yahoo_errors["JPY=X"]
            errors.append(f"USD/JPY：{error}")
            data.setdefault("quoteHealth", {})["USDJPY"] = quote_status("error", attempted_at, error=error)
    for holding in data.get("holdings", []):
        fund_id = holding.get("fundId") or FUND_IDS.get(holding.get("name"))
        smbc_code = holding.get("smbcFundCode") or smbc_fund_code(holding.get("name"))
        is_slow_quote = bool(fund_id or smbc_code or holding.get("quoteSource") == "rakutenGold")
        if is_slow_quote and not include_slow:
            continue
        if not is_slow_quote and not include_fast:
            continue
        try:
            if fund_id:
                holding["fundId"] = fund_id
                quote = rakuten_fund_quote(fund_id)
                source = "Rakuten Securities NAV"
            elif smbc_code:
                holding["smbcFundCode"] = smbc_code
                quote = smbc_fund_quote(smbc_code)
                source = "SMBC Official NAV"
            elif holding.get("quoteSource") == "rakutenGold":
                quote = rakuten_gold_quote()
                source = "Rakuten Securities Gold"
            elif holding.get("quoteSource") == "internationalGold":
                fx_quote = data.get("fx", {}).get("USDJPY", {})
                futures_quote = yahoo_results.get("GC=F")
                if not futures_quote:
                    raise ValueError(yahoo_errors.get("GC=F") or "COMEX 黄金期货行情暂时不可用")
                quote = international_gold_futures_quote(fx_quote, futures_quote)
                source = "COMEX Gold Futures + Yahoo USD/JPY"
            else:
                symbol = holding.get("symbol")
                if not symbol or not holding.get("autoQuote", False):
                    if holding.get("autoQuote", False) and not symbol:
                        raise ValueError("未识别到对应行情，请检查基金名称")
                    continue
                quote = yahoo_results.get(str(symbol))
                if not quote:
                    raise ValueError(yahoo_errors.get(str(symbol)) or "行情暂时不可用")
                source = quote.get("source") or "Yahoo Finance"
                previous_quote = holding.get("quote") or {}
                quote = merge_extended_quote(previous_quote, quote)
            quote = normalize_holding_quote(holding, quote)
            quote["receivedAt"] = attempted_at
            quote["source"] = source
            holding["quote"] = quote
            holding["quoteUpdatedAt"] = attempted_at
            holding["quoteStatus"] = quote_status("ok", attempted_at, slow=is_slow_quote)
            successful_updates += 1
        except Exception as error:
            message = str(error)
            errors.append(f"{holding.get('name', '未知持仓')}：{message}")
            previous_status = holding.get("quoteStatus", {})
            holding["quoteStatus"] = {
                **quote_status("error", attempted_at, error=message, slow=is_slow_quote),
                **({"lastSuccessAt": previous_status["lastSuccessAt"]} if previous_status.get("lastSuccessAt") else {}),
            }
    for holding in data.get("holdings", []):
        if holding.get("quote"):
            holding["quote"]["profitDate"] = holding_profit_date(holding)
    if successful_updates:
        data["lastRefreshAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    data["quoteErrors"] = errors
    return data, errors


def live_patch(data: dict, errors: list[str]) -> dict:
    align_live_calendar_snapshot(data)
    tokyo_today = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    snapshot_dates = current_snapshot_dates(data)
    recent_history = sorted(dashboard_history(data.get("history")), key=lambda item: item.get("date", ""))[-3:]
    current_history_date = recent_history[-1]["date"] if recent_history else tokyo_today
    return {
        "lastRefreshAt": data.get("lastRefreshAt"),
        "fx": copy.deepcopy(data.get("fx", {})),
        "quoteHealth": copy.deepcopy(data.get("quoteHealth", {})),
        "holdings": [
            {
                "id": holding.get("id"),
                "name": holding.get("name"),
                "symbol": holding.get("symbol"),
                "market": holding.get("market"),
                "quoteSource": holding.get("quoteSource"),
                "quote": copy.deepcopy(holding.get("quote")),
                "quoteUpdatedAt": holding.get("quoteUpdatedAt"),
                "quoteStatus": copy.deepcopy(holding.get("quoteStatus")),
            }
            for holding in data.get("holdings", [])
            if holding.get("quote")
        ],
        "currentHistory": copy.deepcopy(next(
            (item for item in reversed(data.get("history", [])) if item.get("date") == current_history_date),
            None,
        )),
        "recentHistory": copy.deepcopy(recent_history),
        "errors": list(errors),
    }


def align_live_calendar_snapshot(data: dict) -> dict:
    if not isinstance(data, dict):
        return data
    for snapshot_date in current_snapshot_dates(data):
        upsert_current_history_snapshot(data, snapshot_date)
    return data


def live_snapshot_persist_due(stored: dict, refreshed: dict) -> bool:
    stored_dates = {
        str(item.get("date"))
        for item in stored.get("history", [])
        if isinstance(item, dict) and item.get("date")
    }
    refreshed_dates = {
        str(item.get("date"))
        for item in refreshed.get("history", [])
        if isinstance(item, dict) and item.get("date")
    }
    if refreshed_dates - stored_dates:
        return True
    last_refresh_at = str(stored.get("lastRefreshAt") or "").strip()
    if not last_refresh_at:
        return True
    try:
        refreshed_at = datetime.fromisoformat(last_refresh_at.replace("Z", "+00:00"))
        if refreshed_at.tzinfo is None:
            refreshed_at = refreshed_at.replace(tzinfo=ZoneInfo("Asia/Tokyo"))
        age_seconds = (datetime.now(timezone.utc) - refreshed_at.astimezone(timezone.utc)).total_seconds()
        return age_seconds >= LIVE_SNAPSHOT_PERSIST_INTERVAL_SECONDS
    except ValueError:
        return True


def persist_cloud_live_snapshot(profile_id: str, stored: dict, refreshed: dict) -> None:
    if not CLOUD_MODE:
        return
    stored_history = {
        str(item.get("date")): item
        for item in stored.get("history", [])
        if isinstance(item, dict) and item.get("date")
    }
    changed_live_history = [
        item
        for item in refreshed.get("history", [])
        if isinstance(item, dict)
        and item.get("date")
        and item.get("live")
        and item != stored_history.get(str(item.get("date")))
    ]
    if not live_snapshot_persist_due(stored, refreshed):
        if changed_live_history:
            cloud_store.write_history_snapshots(profile_id, changed_live_history)
        return
    expected_revision = int(stored.get("_cloudRevision") or stored.get("_profileRevision") or 0)
    cloud_store.write_live_snapshot(profile_id, refreshed, expected_revision)


def publish_live_quotes(data: dict, errors: list[str]) -> None:
    patch = live_patch(data, errors)
    with LIVE_CONDITION:
        LIVE_STATE.update(patch)
        LIVE_STATE["revision"] += 1
        LIVE_CONDITION.notify_all()


def merge_live_quotes(data: dict) -> dict:
    normalize_gold_quote_sources(data)
    with LIVE_CONDITION:
        state = copy.deepcopy(LIVE_STATE)
    data["history"] = dashboard_history(data.get("history"))
    if not state.get("revision"):
        for holding in data.get("holdings", []):
            if holding.get("quote"):
                holding["quote"]["profitDate"] = holding_profit_date(holding)
        return data
    live_by_id = {item.get("id"): item for item in state.get("holdings", []) if item.get("id")}
    live_by_key = {
        (item.get("name"), item.get("symbol")): item
        for item in state.get("holdings", [])
    }
    for holding in data.get("holdings", []):
        patch = live_by_id.get(holding.get("id"))
        if patch and (patch.get("name"), patch.get("symbol")) != (holding.get("name"), holding.get("symbol")):
            patch = None
        patch = patch or live_by_key.get((holding.get("name"), holding.get("symbol")))
        if not patch:
            continue
        for key in ("quoteSource", "quote", "quoteUpdatedAt", "quoteStatus"):
            if patch.get(key) is not None:
                holding[key] = copy.deepcopy(patch[key])
    if state.get("fx"):
        data["fx"] = state["fx"]
    if state.get("quoteHealth"):
        data["quoteHealth"] = state["quoteHealth"]
    if state.get("lastRefreshAt"):
        data["lastRefreshAt"] = state["lastRefreshAt"]
    current_history = state.get("currentHistory")
    if current_history:
        data["history"] = [
            item for item in data.get("history", [])
            if item.get("date") != current_history.get("date")
        ] + [copy.deepcopy(current_history)]
        data["history"].sort(key=lambda item: item.get("date", ""))
    for holding in data.get("holdings", []):
        if holding.get("quote"):
            holding["quote"]["profitDate"] = holding_profit_date(holding)
    data["quoteErrors"] = state.get("errors", [])
    return data


def quote_manager() -> None:
    next_fast_refresh = 0.0
    next_extended_persist = 0.0
    while True:
        now = time.monotonic()
        if now >= next_fast_refresh:
            try:
                stored_data = read_data()
                stored_has_extended = any(
                    (holding.get("quote") or {}).get("extendedSession") in {"pre", "post"}
                    for holding in stored_data.get("holdings", [])
                )
                data = merge_live_quotes(stored_data)
                data, errors = refresh_quote_tier(data, include_fast=True, include_slow=False)
                for snapshot_date in current_snapshot_dates(data):
                    upsert_current_history_snapshot(data, snapshot_date)
                has_extended = any(
                    (holding.get("quote") or {}).get("extendedSession") in {"pre", "post"}
                    for holding in data.get("holdings", [])
                )
                if stored_has_extended != has_extended or (has_extended and now >= next_extended_persist):
                    write_data(data)
                    next_extended_persist = now + 60
                publish_live_quotes(data, errors)
            except Exception as error:
                with LIVE_CONDITION:
                    LIVE_STATE["errors"] = [f"实时行情：{error}"]
            next_fast_refresh = time.monotonic() + LIVE_QUOTE_INTERVAL_SECONDS
        wait_seconds = max(1.0, next_fast_refresh - time.monotonic())
        QUOTE_WAKE_EVENT.wait(wait_seconds)
        if QUOTE_WAKE_EVENT.is_set():
            QUOTE_WAKE_EVENT.clear()
            next_fast_refresh = 0.0


def slow_quote_manager() -> None:
    while True:
        try:
            data = merge_live_quotes(read_data())
            data, errors = refresh_quote_tier(data, include_fast=False, include_slow=True)
            tokyo_today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
            if data.get("accountStartDate"):
                backfill_history(data, tokyo_today)
            for snapshot_date in current_snapshot_dates(data):
                upsert_current_history_snapshot(data, snapshot_date)
            write_data(data)
            publish_live_quotes(data, errors)
        except Exception as error:
            with LIVE_CONDITION:
                LIVE_STATE["errors"] = [f"每日净值：{error}"]
        time.sleep(SLOW_QUOTE_INTERVAL_SECONDS)


def stream_market_date(symbol: str, market: str | None, raw_timestamp: object) -> tuple[int, str]:
    timestamp = int(float(raw_timestamp or time.time()))
    if timestamp > 10_000_000_000:
        timestamp //= 1000
    market_timezone = ZoneInfo("Asia/Tokyo") if market == "JP" or symbol.endswith(".T") else ZoneInfo("America/New_York")
    return timestamp, datetime.fromtimestamp(timestamp, market_timezone).date().isoformat()


def stream_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def apply_yahoo_stream_message(message: dict) -> None:
    global LAST_STREAM_SNAPSHOT_AT
    symbol = str(message.get("id") or "")
    try:
        price = float(message.get("price"))
    except (TypeError, ValueError):
        return
    if not symbol or not math.isfinite(price) or price <= 0:
        return
    received_at = datetime.now(timezone.utc).isoformat()
    market_hours = int(float(message.get("market_hours") or 0))
    stream_change = stream_number(message.get("change"))
    stream_change_pct = stream_number(message.get("change_percent"))
    derived_previous_close = price - stream_change if stream_change is not None else None
    if derived_previous_close is not None and derived_previous_close <= 0:
        derived_previous_close = None
    cache_market = "JP" if symbol == "JPY=X" or symbol.endswith(".T") else "US"
    cache_timestamp, cache_market_date = stream_market_date(symbol, cache_market, message.get("time"))
    if market_hours == 1:
        with STREAM_QUOTE_CACHE_LOCK:
            STREAM_QUOTE_CACHE[symbol] = {
                "price": price,
                "previousClose": derived_previous_close,
                "changePct": stream_change_pct,
                "currency": str(message.get("currency") or ""),
                "marketTime": cache_timestamp,
                "marketDate": cache_market_date,
                "session": "regular",
                "receivedAt": received_at,
            }
    with LIVE_CONDITION:
        if symbol == "JPY=X":
            previous_quote = LIVE_STATE.get("fx", {}).get("USDJPY", {})
            timestamp, market_date = stream_market_date(symbol, "JP", message.get("time"))
            previous_close = float(derived_previous_close or message.get("previous_close") or previous_quote.get("previousClose") or price)
            fx_quote = {
                **previous_quote,
                "price": price,
                "previousClose": previous_close,
                "changePct": stream_change_pct if stream_change_pct is not None else (price / previous_close - 1) * 100,
                "currency": str(message.get("currency") or "JPY"),
                "marketTime": timestamp,
                "marketDate": market_date,
                "receivedAt": received_at,
                "source": "Yahoo Finance Stream",
            }
            LIVE_STATE.setdefault("fx", {})["USDJPY"] = fx_quote
            LIVE_STATE.setdefault("quoteHealth", {})["USDJPY"] = quote_status("ok", received_at)
            for holding in LIVE_STATE.get("holdings", []):
                if holding.get("quoteSource") != "internationalGold":
                    continue
                quote = holding.get("quote") or {}
                spot_price = quote.get("spotUSDPerOunce")
                previous_spot = quote.get("previousSpotUSDPerOunce")
                if not spot_price:
                    continue
                quote["price"] = float(spot_price) * price / TROY_OUNCE_GRAMS
                if previous_spot:
                    quote["previousClose"] = float(previous_spot) * previous_close / TROY_OUNCE_GRAMS
                gold_previous_close = float(quote.get("previousClose") or 0)
                if gold_previous_close:
                    quote["jpyChangePct"] = (float(quote["price"]) / gold_previous_close - 1) * 100
                    quote["changePct"] = quote["jpyChangePct"]
                quote["receivedAt"] = received_at
                holding["quoteUpdatedAt"] = received_at
        elif symbol == "GC=F":
            timestamp, _ = stream_market_date(symbol, "US", message.get("time"))
            fx_quote = LIVE_STATE.get("fx", {}).get("USDJPY", {})
            current_fx = float(fx_quote.get("price") or 0)
            previous_fx = float(fx_quote.get("previousClose") or current_fx or 0)
            for holding in LIVE_STATE.get("holdings", []):
                if holding.get("quoteSource") != "internationalGold":
                    continue
                quote = holding.get("quote") or {}
                quote["futuresUSDPerOunce"] = price
                previous_futures = float(
                    message.get("previous_close")
                    or quote.get("previousFuturesUSDPerOunce")
                    or price
                )
                quote["previousFuturesUSDPerOunce"] = previous_futures
                quote["futuresChangePct"] = stream_change_pct if stream_change_pct is not None else (
                    (price / previous_futures - 1) * 100 if previous_futures else 0
                )
                quote["futuresMarketTime"] = timestamp
                quote["futuresReceivedAt"] = received_at
                if current_fx > 0:
                    quote["price"] = price * current_fx / TROY_OUNCE_GRAMS
                    quote["previousClose"] = previous_futures * previous_fx / TROY_OUNCE_GRAMS
                    quote["changePct"] = (quote["price"] / quote["previousClose"] - 1) * 100 if quote["previousClose"] else 0
                    quote["jpyChangePct"] = quote["changePct"]
                    quote["currency"] = "JPY/g"
                holding["quoteUpdatedAt"] = received_at
                holding["quoteStatus"] = quote_status("ok", received_at)
        else:
            for holding in LIVE_STATE.get("holdings", []):
                if holding.get("symbol") != symbol:
                    continue
                previous_quote = holding.get("quote") or {}
                timestamp, market_date = stream_market_date(symbol, holding.get("market"), message.get("time"))
                same_regular_session = (
                    previous_quote.get("marketSession") == "regular"
                    and str(previous_quote.get("marketDate") or "") == market_date
                    and previous_quote.get("previousClose") is not None
                )
                previous_close = float(
                    previous_quote.get("previousClose")
                    if same_regular_session
                    else derived_previous_close or message.get("previous_close") or previous_quote.get("previousClose") or price
                )
                stream_time = datetime.fromtimestamp(timestamp, timezone.utc)
                stream_session = current_us_market_session(stream_time)
                is_extended = (
                    holding.get("market") == "US"
                    and (market_hours in {0, 2} or stream_session != "regular")
                )
                if is_extended:
                    regular_price = float(previous_quote.get("price") or previous_close or price)
                    regular_market_date = str(previous_quote.get("marketDate") or "")
                    extended_session = stream_session if stream_session in {"pre", "post"} else (
                        "pre" if regular_market_date and market_date > regular_market_date else "post"
                    )
                    quote = {
                        **previous_quote,
                        "extendedPrice": price,
                        "extendedSession": extended_session,
                        "marketSession": extended_session,
                        "extendedMarketTime": timestamp,
                        "extendedChangePct": (price / regular_price - 1) * 100 if regular_price else 0,
                        "extendedReceivedAt": received_at,
                        "receivedAt": received_at,
                    }
                else:
                    quote = {
                        **previous_quote,
                        "price": price,
                        "previousClose": previous_close,
                        "changePct": stream_change_pct if stream_change_pct is not None else (price / previous_close - 1) * 100,
                        "currency": str(message.get("currency") or previous_quote.get("currency") or ""),
                        "marketTime": timestamp,
                        "marketDate": market_date,
                        "marketSession": "regular",
                        "receivedAt": received_at,
                        "source": "Yahoo Finance Stream",
                    }
                    quote = normalize_holding_quote(holding, quote)
                    for key in ("extendedPrice", "extendedSession", "extendedMarketTime", "extendedChangePct", "extendedReceivedAt"):
                        quote.pop(key, None)
                    temporary_holding = {**holding, "quote": quote}
                    quote["profitDate"] = holding_profit_date(temporary_holding)
                holding["quote"] = quote
                holding["quoteUpdatedAt"] = received_at
                holding["quoteStatus"] = quote_status("ok", received_at)
        LIVE_STATE["lastRefreshAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
        refresh_snapshot = time.monotonic() - LAST_STREAM_SNAPSHOT_AT >= 0.9
        if refresh_snapshot:
            LAST_STREAM_SNAPSHOT_AT = time.monotonic()
    snapshot = None
    if refresh_snapshot:
        try:
            live_data = merge_live_quotes(read_data())
            for snapshot_date in current_snapshot_dates(live_data):
                snapshot = upsert_current_history_snapshot(live_data, snapshot_date) or snapshot
        except Exception:
            snapshot = None
    with LIVE_CONDITION:
        if snapshot:
            LIVE_STATE["currentHistory"] = copy.deepcopy(snapshot)
        LIVE_STATE["revision"] += 1
        LIVE_CONDITION.notify_all()


async def wait_for_stream_restart() -> None:
    while not STREAM_WAKE_EVENT.is_set():
        await asyncio.sleep(1)


async def run_yahoo_stream(symbols: list[str]) -> None:
    stream = yfinance.AsyncWebSocket(verbose=False)
    await stream.subscribe(symbols)
    listen_task = asyncio.create_task(stream.listen(apply_yahoo_stream_message))
    restart_task = asyncio.create_task(wait_for_stream_restart())
    done, pending = await asyncio.wait(
        {listen_task, restart_task},
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    await stream.close()
    for task in done:
        task.result()


def yahoo_stream_manager() -> None:
    if yfinance is None:
        return
    while True:
        try:
            data = read_data()
            friend_data = read_friend_profile() or {}
            symbols = {"JPY=X"}
            all_holdings = list(data.get("holdings", [])) + list(friend_data.get("holdings", []))
            if any(holding.get("quoteSource") == "internationalGold" for holding in all_holdings):
                symbols.add("GC=F")
            for holding in all_holdings:
                if (
                    holding.get("symbol")
                    and holding.get("autoQuote", False)
                    and not holding.get("fundId")
                    and not holding.get("quoteSource")
                ):
                    symbols.add(str(holding["symbol"]))
            STREAM_WAKE_EVENT.clear()
            asyncio.run(run_yahoo_stream(sorted(symbols)))
        except Exception as error:
            with LIVE_CONDITION:
                LIVE_STATE["errors"] = [f"行情流：{error}"]
        time.sleep(2)


def load_yfinance_stream() -> None:
    global yfinance
    try:
        yfinance = importlib.import_module("yfinance")
    except Exception:
        yfinance = None
        return
    yahoo_stream_manager()


def refresh_quotes(data: dict, persist: bool = True) -> tuple[dict, list[str]]:
    errors: list[str] = []
    gold_futures_quote = None
    normalize_gold_quote_sources(data)
    for holding in data.get("holdings", []):
        normalize_holding_symbol(holding)
    try:
        data.setdefault("fx", {})["USDJPY"] = yahoo_quote("JPY=X")
    except Exception as error:
        errors.append(f"USD/JPY：{error}")
    if any(holding.get("quoteSource") == "internationalGold" for holding in data.get("holdings", [])):
        try:
            gold_futures_quote = yahoo_quote("GC=F")
        except Exception as error:
            errors.append(f"COMEX黄金期货：{error}")
    for holding in data["holdings"]:
        if holding.get("quoteSource") == "rakutenGold":
            try:
                holding["quote"] = rakuten_gold_quote()
                holding["quoteUpdatedAt"] = datetime.now(timezone.utc).isoformat()
            except Exception as error:
                errors.append(f"{holding['name']}：{error}")
            continue
        if holding.get("quoteSource") == "internationalGold":
            try:
                holding["quote"] = international_gold_quote(data["fx"]["USDJPY"])
                holding["quote"] = attach_gold_futures_quote(holding["quote"], gold_futures_quote)
                holding["quoteUpdatedAt"] = datetime.now(timezone.utc).isoformat()
            except Exception as error:
                errors.append(f"{holding['name']}：{error}")
            continue
        fund_id = holding.get("fundId") or FUND_IDS.get(holding.get("name"))
        smbc_code = holding.get("smbcFundCode") or smbc_fund_code(holding.get("name"))
        if fund_id:
            holding["fundId"] = fund_id
            try:
                holding["quote"] = rakuten_fund_quote(fund_id)
                holding["quoteUpdatedAt"] = datetime.now(timezone.utc).isoformat()
            except Exception as error:
                errors.append(f"{holding['name']}：{error}")
            continue
        if smbc_code:
            holding["smbcFundCode"] = smbc_code
            try:
                holding["quote"] = smbc_fund_quote(smbc_code)
                holding["quoteUpdatedAt"] = datetime.now(timezone.utc).isoformat()
            except Exception as error:
                errors.append(f"{holding['name']}：{error}")
            continue
        symbol = holding.get("symbol")
        if not symbol or not holding.get("autoQuote", False):
            if holding.get("autoQuote", False) and not symbol:
                errors.append(f"{holding.get('name', '未知持仓')}：未识别到对应行情，请检查基金名称")
            continue
        try:
            previous_quote = holding.get("quote") or {}
            quote = yahoo_quote(symbol)
            quote = merge_extended_quote(previous_quote, quote)
            holding["quote"] = normalize_holding_quote(holding, quote)
            holding["quoteUpdatedAt"] = datetime.now(timezone.utc).isoformat()
        except Exception as error:  # keep the previous quote visible on failure
            errors.append(f"{holding['name']}：{error}")
    for holding in data["holdings"]:
        if holding.get("quote"):
            holding["quote"]["profitDate"] = holding_profit_date(holding)
    now = datetime.now(timezone(timedelta(hours=9)))
    if data.get("accountStartDate"):
        backfill_history(data, now.date())
    for snapshot_date in current_snapshot_dates(data):
        upsert_current_history_snapshot(data, snapshot_date)
    data["lastRefreshAt"] = now.isoformat()
    if persist:
        write_data(data)
    return data, errors


def normalize_transactions(transactions: object) -> list[dict]:
    if not isinstance(transactions, list):
        raise ValueError("交易流水格式不正确")
    normalized = []
    for transaction in transactions:
        if not isinstance(transaction, dict) or transaction.get("type") not in {"BUY", "SELL"}:
            raise ValueError("交易流水格式不正确")
        timestamp = str(transaction.get("timestamp") or "")
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        name = str(transaction.get("name") or "").strip()
        if not name or len(name) > 80:
            raise ValueError("交易标的名称不正确")
        numeric_fields = {
            "price": float(transaction.get("price")),
            "quantity": float(transaction.get("quantity")),
            "fee": float(transaction.get("fee") or 0),
            "exchangeRate": float(transaction.get("exchangeRate") or 1),
            "unitScale": float(transaction.get("unitScale") or 1),
            "amountJPY": float(transaction.get("amountJPY")),
            "externalCashFlowJPY": float(transaction.get("externalCashFlowJPY")),
            "averageCostBeforeJPY": float(transaction.get("averageCostBeforeJPY") or 0),
            "averageCostAfterJPY": float(transaction.get("averageCostAfterJPY") or 0),
            "realizedProfitJPY": float(transaction.get("realizedProfitJPY") or 0),
        }
        if any(not math.isfinite(value) for value in numeric_fields.values()):
            raise ValueError("交易流水金额不正确")
        if numeric_fields["price"] < 0 or numeric_fields["quantity"] <= 0 or numeric_fields["fee"] < 0:
            raise ValueError("交易流水金额不正确")
        normalized.append({
            "id": str(transaction.get("id") or secrets.token_urlsafe(12)),
            "holdingId": str(transaction.get("holdingId") or ""),
            "name": name,
            "symbol": str(transaction.get("symbol") or ""),
            "market": str(transaction.get("market") or "JP"),
            "account": normalize_account_type(transaction.get("account")),
            "product": str(transaction.get("product") or "未设置"),
            "type": transaction["type"],
            "price": numeric_fields["price"],
            "quantity": numeric_fields["quantity"],
            "fee": numeric_fields["fee"],
            "currency": str(transaction.get("currency") or "JPY"),
            "exchangeRate": numeric_fields["exchangeRate"],
            "unitScale": numeric_fields["unitScale"],
            "amountJPY": numeric_fields["amountJPY"],
            "externalCashFlowJPY": numeric_fields["externalCashFlowJPY"],
            "averageCostBeforeJPY": numeric_fields["averageCostBeforeJPY"],
            "averageCostAfterJPY": numeric_fields["averageCostAfterJPY"],
            "realizedProfitJPY": numeric_fields["realizedProfitJPY"],
            "timestamp": timestamp,
            "fundId": transaction.get("fundId"),
            "quoteSource": transaction.get("quoteSource"),
            "annualizedOnly": bool(transaction.get("annualizedOnly")),
        })
    return normalized


def normalize_realized_trades(realized_trades: object) -> list[dict]:
    if not isinstance(realized_trades, list):
        raise ValueError("收益记录格式不正确")
    normalized = []
    for trade in realized_trades:
        if not isinstance(trade, dict):
            raise ValueError("收益记录格式不正确")
        trade_date = str(trade.get("date", ""))
        date.fromisoformat(trade_date)
        name = str(trade.get("name", "")).strip()
        if not name or len(name) > 80:
            raise ValueError("收益记录的标的名称不正确")
        proceeds = float(trade.get("proceedsJPY"))
        realized_profit = float(trade.get("realizedProfitJPY"))
        if not math.isfinite(proceeds) or proceeds < 0 or not math.isfinite(realized_profit):
            raise ValueError("收益记录金额不正确")
        normalized.append({
            "id": str(trade.get("id") or secrets.token_urlsafe(12)),
            "transactionId": str(trade.get("transactionId") or ""),
            "date": trade_date,
            "name": name,
            "proceedsJPY": proceeds,
            "realizedProfitJPY": realized_profit,
            "note": str(trade.get("note", "")).strip()[:120],
            "kind": "DIVIDEND" if trade.get("kind") == "DIVIDEND" else "SELL",
            "account": str(trade.get("account") or ""),
            "product": str(trade.get("product") or ""),
            "createdAt": str(trade.get("createdAt", "")),
        })
    return normalized


def ensure_sell_realized_trades(transactions: list[dict], realized_trades: list[dict]) -> list[dict]:
    result = list(realized_trades)
    recorded_transaction_ids = {
        trade.get("transactionId")
        for trade in result
        if trade.get("transactionId")
    }
    for transaction in transactions:
        transaction_id = str(transaction.get("id") or "")
        if transaction.get("type") != "SELL" or transaction_id in recorded_transaction_ids:
            continue
        timestamp = str(transaction.get("timestamp") or "")
        result.append({
            "id": f"sale-{transaction_id}",
            "transactionId": transaction_id,
            "date": timestamp[:10],
            "name": transaction["name"],
            "proceedsJPY": transaction["amountJPY"],
            "realizedProfitJPY": transaction["realizedProfitJPY"],
            "note": "由卖出交易自动记录",
            "kind": "SELL",
            "account": transaction.get("account") or "",
            "product": transaction.get("product") or "",
            "createdAt": timestamp,
        })
        recorded_transaction_ids.add(transaction_id)
    return result


def normalize_trade_records(data: dict) -> None:
    transactions = normalize_transactions(data.get("transactions", []))
    realized_trades = normalize_realized_trades(data.get("realizedTrades", []))
    data["transactions"] = transactions
    data["realizedTrades"] = ensure_sell_realized_trades(transactions, realized_trades)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        request_path = urllib.parse.urlsplit(self.path).path
        if not request_path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        use_gzip = len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if use_gzip:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def request_cookies(self) -> SimpleCookie:
        return SimpleCookie(self.headers.get("Cookie", ""))

    def discard_request_body(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            content_length = 0
        if content_length > 0:
            self.rfile.read(content_length)
            return
        if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
            return
        while True:
            size_line = self.rfile.readline().strip().split(b";", 1)[0]
            if not size_line:
                return
            try:
                chunk_size = int(size_line, 16)
            except ValueError:
                return
            if chunk_size == 0:
                while self.rfile.readline().strip():
                    pass
                return
            self.rfile.read(chunk_size)
            self.rfile.read(2)

    def session_mode(self) -> str | None:
        cookies = self.request_cookies()
        admin_cookie = cookies.get("portfolio_admin")
        user_cookie = cookies.get("portfolio_user")
        if admin_cookie and secrets.compare_digest(admin_cookie.value, ADMIN_SESSION_TOKEN):
            return "admin"
        owner_cookie = cookies.get("portfolio_token")
        friend_cookie = cookies.get("portfolio_profile")
        if owner_cookie and secrets.compare_digest(owner_cookie.value, ACCESS_TOKEN):
            return "owner"
        if friend_cookie and secrets.compare_digest(friend_cookie.value, FRIEND_PROFILE_TOKEN):
            return "friend"
        if user_cookie and verify_user_cookie(user_cookie.value):
            return "user"
        return None

    def session_user_id(self) -> str | None:
        user_cookie = self.request_cookies().get("portfolio_user")
        return verify_user_cookie(user_cookie.value) if user_cookie else None

    def account_profile_id(self) -> str:
        user_id = self.session_user_id()
        return user_profile_id(user_id) if user_id else "friend"

    def send_login_result(
        self,
        mode: str,
        user_id: str | None = None,
        extra: dict | None = None,
        mark_trial_created: bool = False,
    ) -> None:
        max_age = 60 * 60 * 24 * 365
        secure = "; Secure" if CLOUD_MODE else ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        if mode == "owner":
            self.send_header("Set-Cookie", f"portfolio_token={ACCESS_TOKEN}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
            self.send_header("Set-Cookie", f"portfolio_profile=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}")
        elif mode == "friend":
            self.send_header("Set-Cookie", f"portfolio_profile={FRIEND_PROFILE_TOKEN}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
            self.send_header("Set-Cookie", f"portfolio_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}")
        elif mode == "admin":
            self.send_header("Set-Cookie", f"portfolio_admin={ADMIN_SESSION_TOKEN}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
        elif mode == "user" and user_id:
            self.send_header("Set-Cookie", f"portfolio_user={signed_user_cookie(user_id)}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
        for cookie_name in {
            "owner": ("portfolio_profile", "portfolio_admin", "portfolio_user"),
            "friend": ("portfolio_token", "portfolio_admin", "portfolio_user"),
            "admin": ("portfolio_token", "portfolio_profile", "portfolio_user"),
            "user": ("portfolio_token", "portfolio_profile", "portfolio_admin"),
        }.get(mode, ()):
            self.send_header("Set-Cookie", f"{cookie_name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}")
        if mark_trial_created:
            self.send_header("Set-Cookie", f"portfolio_trial_created={TRIAL_CREATED_TOKEN}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
        self.send_header("Set-Cookie", f"portfolio_mode={mode}; Path=/; Max-Age={max_age}; SameSite=Lax{secure}")
        payload = {"authenticated": True, "mode": mode}
        if user_id:
            payload["userId"] = user_id
        if extra:
            payload.update(extra)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def clear_login_session(self) -> None:
        secure = "; Secure" if CLOUD_MODE else ""
        body = b'{"authenticated":false}'
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Set-Cookie", f"portfolio_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}")
        self.send_header("Set-Cookie", f"portfolio_profile=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}")
        self.send_header("Set-Cookie", f"portfolio_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}")
        self.send_header("Set-Cookie", f"portfolio_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}")
        self.send_header("Set-Cookie", f"portfolio_mode=; Path=/; Max-Age=0; SameSite=Strict{secure}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream_live_quotes(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            last_revision = int(self.headers.get("Last-Event-ID") or query.get("revision", [0])[0])
        except (TypeError, ValueError):
            last_revision = 0
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                with LIVE_CONDITION:
                    LIVE_CONDITION.wait_for(
                        lambda: LIVE_STATE["revision"] > last_revision,
                        timeout=STREAM_HEARTBEAT_SECONDS,
                    )
                    state = copy.deepcopy(LIVE_STATE)
                if state["revision"] > last_revision:
                    payload = json.dumps(
                        {key: value for key, value in state.items() if key != "revision"},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    message = f"id: {state['revision']}\nevent: quotes\ndata: {payload}\n\n"
                    last_revision = state["revision"]
                else:
                    message = ": keepalive\n\n"
                self.wfile.write(message.encode("utf-8"))
                self.wfile.flush()
        except OSError:
            return
        finally:
            self.close_connection = True

    def authorize(self) -> bool:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/cron-refresh":
            configured_secret = os.environ.get("CRON_SECRET", "").strip()
            supplied_secret = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if configured_secret and secrets.compare_digest(supplied_secret, configured_secret):
                return True
            self.send_json({"error": "定时刷新口令无效"}, HTTPStatus.FORBIDDEN)
            return False
        if parsed.path in {
            "/api/profile-portfolio",
            "/api/profile-portfolio-core",
            "/api/profile-portfolio-history",
            "/api/profile-refresh",
            "/api/profile-live-quotes",
            "/api/profile-goal-simulator",
            "/api/profile-goal-ai-forecast",
            "/api/profile-goal-ai-report",
            "/api/profile-daily-ai-summary",
        }:
            if self.session_mode() == "user" and self.session_user_id():
                return True
            query_profile = urllib.parse.parse_qs(parsed.query).get("profile", [None])[0]
            header_profile = self.headers.get("X-Portfolio-Profile")
            profile_cookie = self.request_cookies().get("portfolio_profile")
            supplied_profile = query_profile or header_profile or (profile_cookie.value if profile_cookie else None)
            if supplied_profile and secrets.compare_digest(supplied_profile, FRIEND_PROFILE_TOKEN):
                return True
            self.send_json({"error": "朋友口令无效"}, HTTPStatus.FORBIDDEN)
            return False
        if self.command == "POST" and parsed.path == "/api/local-refresh":
            return True
        if self.command == "GET" and not parsed.path.startswith("/api/"):
            return True
        query_token = urllib.parse.parse_qs(parsed.query).get("token", [None])[0]
        header_token = self.headers.get("X-Portfolio-Token")
        cookie = self.request_cookies()
        cookie_token = cookie.get("portfolio_token")
        supplied_token = query_token or header_token or (cookie_token.value if cookie_token else None)
        if supplied_token and secrets.compare_digest(supplied_token, ACCESS_TOKEN):
            return True
        self.send_json({"error": "需要访问口令"}, HTTPStatus.FORBIDDEN)
        return False

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        request_path = parsed.path
        if request_path == "/api/session":
            mode = self.session_mode()
            self.send_json({"authenticated": bool(mode), "mode": mode, "userId": self.session_user_id()})
            return
        if request_path == "/api/admin/accounts":
            if self.session_mode() != "admin":
                self.send_json({"error": "需要管理员权限"}, HTTPStatus.FORBIDDEN)
                return
            accounts = []
            for account in read_test_accounts():
                ai_usage = account_ai_usage(account)
                accounts.append({
                    key: account.get(key)
                    for key in ("id", "loginKey", "keySuffix", "status", "createdAt", "trialEndsAt", "lastLoginAt", "aiEnabled")
                } | {"active": account_is_active(account), "aiEnabled": ai_usage["enabled"], "aiUsage": ai_usage})
            self.send_json({"accounts": accounts})
            return
        if request_path == "/api/ai-usage":
            user_id = self.session_user_id()
            if not user_id:
                self.send_json({"error": "需要用户账号"}, HTTPStatus.FORBIDDEN)
                return
            account = next((item for item in read_test_accounts() if item.get("id") == user_id), None)
            if not account:
                self.send_json({"error": "账户不存在"}, HTTPStatus.NOT_FOUND)
                return
            self.send_json(account_ai_usage(account))
            return
        if request_path == "/admin.html" and self.session_mode() != "admin":
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/login.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if request_path in {"/", "/index.html"}:
            query = urllib.parse.parse_qs(parsed.query)
            has_legacy_key = bool(query.get("token", [None])[0] or query.get("profile", [None])[0])
            is_local_test = query.get("local", [None])[0] == "1"
            session_mode = self.session_mode()
            requested_mode = query.get("mode", [None])[0]
            requested_user_id = query.get("user", [None])[0]
            if requested_mode == "user" and (
                session_mode != "user" or not requested_user_id or requested_user_id != self.session_user_id()
            ):
                self.path = "/login.html"
                super().do_GET()
                return
            if not session_mode and not has_legacy_key and not is_local_test:
                self.path = "/login.html"
                super().do_GET()
                return
            if session_mode == "admin":
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", "/admin.html")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if session_mode == "user" and not query.get("user", [None])[0]:
                user_id = self.session_user_id()
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", f"/?local=1&mode=user&user={urllib.parse.quote(user_id or '')}")
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not CLOUD_MODE and session_mode and not query.get("mode", [None])[0]:
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", f"/?mode={urllib.parse.quote(session_mode)}")
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        if not self.authorize():
            return
        if request_path == "/api/profile-portfolio":
            try:
                profile = read_account_profile(self.account_profile_id())
                if isinstance(profile, dict):
                    align_live_calendar_snapshot(profile)
                    profile["history"] = dashboard_history(profile.get("history"))
                self.send_json({"portfolio": profile})
            except (OSError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/profile-portfolio-core":
            try:
                profile = read_account_profile_core(self.account_profile_id(), recent_history_limit=3)
                self.send_json({"portfolio": align_live_calendar_snapshot(profile)})
            except (OSError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/profile-portfolio-history":
            try:
                self.send_json({"history": dashboard_history(read_profile_history(self.account_profile_id()))})
            except (OSError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/profile-goal-simulator":
            try:
                self.send_json({"settings": read_goal_settings(self.account_profile_id())})
            except (OSError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/portfolio":
            self.send_json(align_live_calendar_snapshot(merge_live_quotes(read_data())))
            return
        if request_path == "/api/portfolio-core":
            self.send_json(align_live_calendar_snapshot(merge_live_quotes(read_data_core(recent_history_limit=3))))
            return
        if request_path == "/api/portfolio-history":
            self.send_json({"history": dashboard_history(read_profile_history("owner"))})
            return
        if request_path == "/api/portfolio-summary":
            data = align_live_calendar_snapshot(merge_live_quotes(read_data()))
            self.send_json({
                "holdings": data.get("holdings", []),
                "fx": data.get("fx", {}),
                "transactions": data.get("transactions", []),
                "realizedTrades": data.get("realizedTrades", []),
                "history": [
                    {
                        "date": item.get("date"),
                        "dailyProfitJPY": item.get("dailyProfitJPY", 0),
                        "totalAssetsJPY": item.get("totalAssetsJPY", 0),
                        "totalNetAsset": item.get("totalNetAsset", item.get("totalAssetsJPY", 0)),
                        "netExternalCashFlowJPY": item.get("netExternalCashFlowJPY", 0),
                        "weightedExternalCashFlowJPY": item.get("weightedExternalCashFlowJPY", 0),
                        "dailyReturnRate": item.get("dailyReturnRate"),
                        "dailyProfitRate": item.get("dailyProfitRate"),
                    }
                    for item in data.get("history", [])
                    if item.get("date")
                ],
                "accountStartDate": data.get("accountStartDate"),
                "investmentPlan": data.get("investmentPlan", ""),
                "lastRefreshAt": data.get("lastRefreshAt"),
            })
            return
        if request_path == "/api/live-quotes":
            if CLOUD_MODE:
                data = read_data_core(recent_history_limit=3)
                refreshed, errors = refresh_quote_tier(
                    copy.deepcopy(data),
                    include_fast=True,
                    include_slow=friend_slow_quotes_due(data),
                )
                for snapshot_date in current_snapshot_dates(refreshed):
                    upsert_current_history_snapshot(refreshed, snapshot_date)
                persist_cloud_live_snapshot("owner", data, refreshed)
                self.send_json(live_patch(refreshed, errors))
            else:
                data = merge_live_quotes(read_data())
                self.send_json(live_patch(data, data.get("quoteErrors", [])))
            return
        if request_path == "/api/cron-refresh":
            try:
                results = {}
                owner, owner_errors = refresh_quotes(read_data())
                results["owner"] = {"updatedAt": owner.get("lastRefreshAt"), "errors": owner_errors}
                friend = read_friend_profile()
                if friend:
                    expected_revision = int(friend.get("_profileRevision") or 0)
                    refreshed_friend, friend_errors = refresh_quotes(copy.deepcopy(friend), persist=False)
                    saved_friend = write_friend_profile(refreshed_friend, expected_revision=expected_revision)
                    results["friend"] = {"updatedAt": saved_friend.get("lastRefreshAt"), "errors": friend_errors}
                self.send_json({"ok": True, "profiles": results})
            except Exception as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/goal-simulator":
            try:
                self.send_json({"settings": read_goal_settings("owner")})
            except (OSError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/stream":
            self.stream_live_quotes()
            return
        if request_path == "/api/analysis-prompt":
            self.send_json({"prompt": PROMPT_FILE.read_text(encoding="utf-8")})
            return
        if request_path == "/api/ai-status":
            try:
                if gemini_ai is None or not gemini_ai.configured():
                    self.send_json({"ok": False, "error": "AI API 尚未配置"}, HTTPStatus.SERVICE_UNAVAILABLE)
                    return
                self.send_json(gemini_ai.check_connection())
            except gemini_ai.GeminiAIError as error:
                self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_GATEWAY)
            return
        super().do_GET()

    def handle_user_daily_ai(self) -> None:
        user_id = self.session_user_id()
        if not user_id:
            self.send_json({"error": "需要用户账号"}, HTTPStatus.FORBIDDEN)
            return
        reserved = False
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 1_500_000:
                raise ValueError("单日总结请求大小不正确")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("单日总结请求格式不正确")
            date_text = str(payload.get("date") or "").strip()
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                raise ValueError("请选择有效的收益日期")
            portfolio = payload.get("portfolio")
            if not isinstance(portfolio, dict) or not isinstance(portfolio.get("history"), list):
                raise ValueError("当前账号的收益历史不可用")
            if len(portfolio.get("holdings") or []) > 200 or len(portfolio["history"]) > 5000:
                raise ValueError("当前账号的持仓或历史数据过多")
            if gemini_ai is None or not gemini_ai.configured():
                self.send_json({"error": "AI API 尚未配置"}, HTTPStatus.SERVICE_UNAVAILABLE)
                return
            selected_record = payload.get("record")
            portfolio = copy.deepcopy(portfolio)
            if isinstance(selected_record, dict) and selected_record.get("date") == date_text:
                portfolio["history"] = [
                    item for item in portfolio["history"]
                    if isinstance(item, dict) and item.get("date") != date_text
                ] + [copy.deepcopy(selected_record)]
                portfolio["history"].sort(key=lambda item: str(item.get("date") or ""))
            usage = reserve_account_ai_usage(user_id, "calendar")
            reserved = True
            analysis_date = gemini_ai.resolve_daily_summary_date(portfolio, date_text)
            report = compact_daily_ai_report(gemini_ai.build_daily_portfolio_summary(portfolio, analysis_date))
            self.send_json({
                "report": report,
                "analysisDate": analysis_date,
                "fallbackFrom": date_text if analysis_date != date_text else None,
                "saved": False,
                "aiUsage": usage,
            })
        except AccountAIError as error:
            self.send_json({"error": str(error)}, error.status)
        except gemini_ai.GeminiRateLimitError as error:
            if reserved:
                refund_account_ai_usage(user_id, "calendar")
            self.send_json({"error": str(error), "retryAfter": error.retry_after}, HTTPStatus.TOO_MANY_REQUESTS)
        except gemini_ai.GeminiAIError as error:
            if reserved:
                refund_account_ai_usage(user_id, "calendar")
            self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            if reserved:
                refund_account_ai_usage(user_id, "calendar")
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            if reserved:
                refund_account_ai_usage(user_id, "calendar")
            traceback.print_exc()
            self.send_json({"error": f"单日总结失败：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_user_goal_ai(self, request_path: str) -> None:
        user_id = self.session_user_id()
        if not user_id:
            self.send_json({"error": "需要用户账号"}, HTTPStatus.FORBIDDEN)
            return
        reserved = False
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 1_500_000:
                raise ValueError("AI 预测请求大小不正确")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("AI 预测请求格式不正确")
            portfolio = payload.get("portfolio")
            if not isinstance(portfolio, dict) or not isinstance(portfolio.get("holdings"), list):
                raise ValueError("当前账号的持仓数据不可用")
            if len(portfolio["holdings"]) > 200 or len(portfolio.get("history") or []) > 5000:
                raise ValueError("当前账号的持仓或历史数据过多")
            if gemini_ai is None or not gemini_ai.configured():
                self.send_json({"error": "AI API 尚未配置"}, HTTPStatus.SERVICE_UNAVAILABLE)
                return
            usage = reserve_account_ai_usage(user_id, "forecast")
            reserved = True
            portfolio = copy.deepcopy(portfolio)
            if request_path.endswith("-forecast"):
                goal = payload.get("goal")
                if not isinstance(goal, dict) or not isinstance(goal.get("assetTypes"), list):
                    raise ValueError("目标预测设置格式不正确")
                forecast = gemini_ai.forecast_asset_returns(portfolio, goal)
                report = forecast.pop("report", None)
                self.send_json({"forecast": forecast, "report": report, "savedSettings": None, "aiUsage": usage})
                return
            forecast = payload.get("forecast")
            blueprint = payload.get("blueprint")
            if not isinstance(forecast, dict) or not isinstance(blueprint, dict):
                raise ValueError("资产蓝图数据格式不正确")
            self.send_json({
                "report": gemini_ai.build_blueprint_report(portfolio, forecast, blueprint),
                "aiUsage": usage,
            })
        except AccountAIError as error:
            self.send_json({"error": str(error)}, error.status)
        except gemini_ai.GeminiRateLimitError as error:
            if reserved:
                refund_account_ai_usage(user_id, "forecast")
            self.send_json({"error": str(error), "retryAfter": error.retry_after}, HTTPStatus.TOO_MANY_REQUESTS)
        except gemini_ai.GeminiAIError as error:
            if reserved:
                refund_account_ai_usage(user_id, "forecast")
            self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            if reserved:
                refund_account_ai_usage(user_id, "forecast")
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            if reserved:
                refund_account_ai_usage(user_id, "forecast")
            traceback.print_exc()
            self.send_json({"error": f"AI 分析失败：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        request_path = urllib.parse.urlsplit(self.path).path
        if request_path == "/api/register":
            self.discard_request_body()
            self.send_json({"error": "体验密钥只能由管理员创建"}, HTTPStatus.FORBIDDEN)
            return
        if request_path == "/api/admin/create-account":
            self.discard_request_body()
            if self.session_mode() != "admin":
                self.send_json({"error": "需要管理员权限"}, HTTPStatus.FORBIDDEN)
                return
            account, raw_key = create_trial_account()
            self.send_json({
                "ok": True,
                "userId": account["id"],
                "key": raw_key,
                "trialEndsAt": account["trialEndsAt"],
            })
            return
        if request_path == "/api/login":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 4096:
                    raise ValueError("密钥格式不正确")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                supplied_key = str(payload.get("key") or "").strip()
                if ADMIN_LOGIN_KEY and secrets.compare_digest(supplied_key, ADMIN_LOGIN_KEY):
                    self.send_login_result("admin")
                    return
                if secrets.compare_digest(supplied_key, OWNER_LOGIN_KEY):
                    self.send_login_result("owner")
                    return
                if secrets.compare_digest(supplied_key, FRIEND_LOGIN_KEY):
                    self.send_login_result("friend")
                    return
                supplied_hash = login_key_hash(supplied_key)
                accounts = read_test_accounts()
                account = next((item for item in accounts if hmac.compare_digest(str(item.get("keyHash") or ""), supplied_hash)), None)
                if account:
                    if not account_is_active(account):
                        message = "账户已暂停" if account.get("status") == "suspended" else "体验期已结束，数据仍然保留"
                        self.send_json({"error": message}, HTTPStatus.FORBIDDEN)
                        return
                    account["lastLoginAt"] = datetime.now(timezone.utc).isoformat()
                    write_test_accounts(accounts)
                    self.send_login_result("user", str(account["id"]))
                    return
                self.send_json({"error": "密钥不正确"}, HTTPStatus.FORBIDDEN)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if request_path == "/api/admin/account-status":
            if self.session_mode() != "admin":
                self.send_json({"error": "需要管理员权限"}, HTTPStatus.FORBIDDEN)
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 4096:
                    raise ValueError("请求格式不正确")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                account_id = str(payload.get("id") or "")
                action = str(payload.get("action") or "")
                accounts = read_test_accounts()
                account = next((item for item in accounts if item.get("id") == account_id), None)
                if not account:
                    self.send_json({"error": "账户不存在"}, HTTPStatus.NOT_FOUND)
                    return
                now = datetime.now(timezone.utc)
                if action == "lifetime":
                    account["status"] = "lifetime"
                elif action in {"extend7", "extend30", "restore"}:
                    try:
                        current_end = datetime.fromisoformat(str(account.get("trialEndsAt") or "").replace("Z", "+00:00"))
                    except ValueError:
                        current_end = now
                    account["status"] = "trial"
                    extension_days = 30 if action == "extend30" else 7
                    account["trialEndsAt"] = (max(now, current_end) + timedelta(days=extension_days)).isoformat()
                elif action == "suspend":
                    account["status"] = "suspended"
                elif action == "enableAi":
                    account["aiEnabled"] = True
                elif action == "disableAi":
                    account["aiEnabled"] = False
                elif action == "resetKey":
                    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
                    existing_hashes = {str(item.get("keyHash") or "") for item in accounts}
                    while True:
                        raw_key = "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))
                        hashed_key = login_key_hash(raw_key)
                        if hashed_key not in existing_hashes:
                            break
                    account["keyHash"] = hashed_key
                    account["loginKey"] = raw_key
                    account["keySuffix"] = raw_key[-4:]
                    write_test_accounts(accounts)
                    self.send_json({"ok": True, "key": raw_key})
                    return
                elif action == "delete":
                    accounts = [item for item in accounts if item.get("id") != account_id]
                    if CLOUD_MODE:
                        cloud_store.delete_profile(user_profile_id(account_id))
                    user_directory = TEST_USER_DATA_DIR / account_id
                    if user_directory.is_dir() and user_directory.parent == TEST_USER_DATA_DIR:
                        shutil.rmtree(user_directory)
                    write_test_accounts(accounts)
                    self.send_json({"ok": True, "deletedId": account_id})
                    return
                else:
                    raise ValueError("未知操作")
                write_test_accounts(accounts)
                self.send_json({"ok": True})
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if request_path == "/api/logout":
            self.discard_request_body()
            self.clear_login_session()
            return
        if self.session_mode() == "user":
            if request_path == "/api/daily-ai-summary":
                self.handle_user_daily_ai()
                return
            if request_path in {"/api/goal-ai-forecast", "/api/goal-ai-report"}:
                self.handle_user_goal_ai(request_path)
                return
        if not self.authorize():
            return
        if request_path in {"/api/daily-ai-summary", "/api/profile-daily-ai-summary"}:
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 200_000:
                    raise ValueError("单日总结请求大小不正确")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("单日总结请求格式不正确")
                date_text = str(payload.get("date") or "").strip()
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                    raise ValueError("请选择有效的收益日期")
                if gemini_ai is None or not gemini_ai.configured():
                    self.send_json({"error": "AI API 尚未配置"}, HTTPStatus.SERVICE_UNAVAILABLE)
                    return
                is_friend = request_path.startswith("/api/profile-")
                portfolio = read_friend_profile() if is_friend else merge_live_quotes(read_data())
                if not isinstance(portfolio, dict) or not isinstance(portfolio.get("history"), list):
                    raise ValueError("当前收益历史不可用")
                selected_record = payload.get("record")
                if isinstance(selected_record, dict) and selected_record.get("date") == date_text:
                    portfolio["history"] = [
                        item for item in portfolio["history"]
                        if isinstance(item, dict) and item.get("date") != date_text
                    ] + [copy.deepcopy(selected_record)]
                    portfolio["history"].sort(key=lambda item: str(item.get("date") or ""))
                analysis_date = gemini_ai.resolve_daily_summary_date(portfolio, date_text)
                report = gemini_ai.build_daily_portfolio_summary(portfolio, analysis_date)
                profile_id = "friend" if is_friend else "owner"
                saved_report = save_daily_ai_summary(profile_id, analysis_date, report)
                self.send_json({
                    "report": saved_report,
                    "analysisDate": analysis_date,
                    "fallbackFrom": date_text if analysis_date != date_text else None,
                    "saved": True,
                })
            except gemini_ai.GeminiRateLimitError as error:
                self.send_json(
                    {"error": str(error), "retryAfter": error.retry_after},
                    HTTPStatus.TOO_MANY_REQUESTS,
                )
            except gemini_ai.GeminiAIError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except Exception as error:
                traceback.print_exc()
                self.send_json({"error": f"单日总结失败：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path in {
            "/api/goal-ai-forecast",
            "/api/profile-goal-ai-forecast",
            "/api/goal-ai-report",
            "/api/profile-goal-ai-report",
        }:
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 600_000:
                    raise ValueError("AI 预测请求大小不正确")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("AI 预测请求格式不正确")
                if gemini_ai is None or not gemini_ai.configured():
                    self.send_json({"error": "AI API 尚未配置"}, HTTPStatus.SERVICE_UNAVAILABLE)
                    return
                is_friend = request_path.startswith("/api/profile-")
                portfolio = read_friend_profile() if is_friend else merge_live_quotes(read_data())
                if not isinstance(portfolio, dict) or not isinstance(portfolio.get("holdings"), list):
                    raise ValueError("当前持仓数据不可用")
                if request_path.endswith("-forecast"):
                    goal = payload.get("goal")
                    if not isinstance(goal, dict) or not isinstance(goal.get("assetTypes"), list):
                        raise ValueError("目标预测设置格式不正确")
                    forecast = gemini_ai.forecast_asset_returns(portfolio, goal)
                    report = forecast.pop("report", None)
                    settings_snapshot = payload.get("settingsSnapshot")
                    saved_settings = None
                    if isinstance(settings_snapshot, dict) and isinstance(report, dict):
                        profile_id = "friend" if is_friend else "owner"
                        saved_settings = save_goal_ai_result(profile_id, settings_snapshot, forecast, report)
                    self.send_json({"forecast": forecast, "report": report, "savedSettings": saved_settings})
                    return
                forecast = payload.get("forecast")
                blueprint = payload.get("blueprint")
                if not isinstance(forecast, dict) or not isinstance(blueprint, dict):
                    raise ValueError("资产蓝图数据格式不正确")
                self.send_json({"report": gemini_ai.build_blueprint_report(portfolio, forecast, blueprint)})
            except gemini_ai.GeminiRateLimitError as error:
                self.send_json(
                    {"error": str(error), "retryAfter": error.retry_after},
                    HTTPStatus.TOO_MANY_REQUESTS,
                )
            except gemini_ai.GeminiAIError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except Exception as error:
                traceback.print_exc()
                self.send_json({"error": f"AI 分析失败：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/profile-portfolio":
            try:
                profile_id = self.account_profile_id()
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 25_000_000:
                    raise ValueError("持仓备份大小不正确")
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict) or not isinstance(data.get("holdings"), list):
                    raise ValueError("持仓备份格式不正确")
                if len(data["holdings"]) > 50:
                    raise ValueError("持仓数量过多")
                normalize_trade_records(data)
                expected_revision = int(data.get("_profileRevision") or 0)
                saved = write_account_profile(profile_id, data, expected_revision=expected_revision)
                STREAM_WAKE_EVENT.set()
                self.send_json({"portfolio": saved})
            except ProfileConflictError as error:
                self.send_json({"error": str(error), "portfolio": read_account_profile(self.account_profile_id())}, HTTPStatus.CONFLICT)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except OSError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/profile-goal-simulator":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 200_000:
                    raise ValueError("目标预测设置大小不正确")
                settings = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(settings, dict):
                    raise ValueError("目标预测设置格式不正确")
                self.send_json({"settings": write_goal_settings(self.account_profile_id(), settings)})
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except OSError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path in {"/api/profile-refresh", "/api/profile-live-quotes"}:
            try:
                profile_id = self.account_profile_id()
                self.discard_request_body()
                data = read_account_profile_core(profile_id, recent_history_limit=3) if request_path == "/api/profile-live-quotes" else read_account_profile(profile_id)
                if not data:
                    raise ValueError("持仓尚未建立，请先导入或添加持仓")
                expected_revision = int(data.get("_profileRevision") or 0)
                if request_path == "/api/profile-refresh":
                    refreshed, errors = refresh_quotes(copy.deepcopy(data), persist=False)
                else:
                    refreshed, errors = refresh_quote_tier(
                        copy.deepcopy(data),
                        include_fast=True,
                        include_slow=friend_slow_quotes_due(data),
                    )
                    for snapshot_date in current_snapshot_dates(refreshed):
                        upsert_current_history_snapshot(refreshed, snapshot_date)
                    persist_cloud_live_snapshot(profile_id, data, refreshed)
                if request_path == "/api/profile-live-quotes":
                    patch = live_patch(refreshed, errors)
                    patch["profileRevision"] = data.get("_profileRevision")
                    patch["profileSavedAt"] = data.get("_profileSavedAt")
                    self.send_json(patch)
                else:
                    saved = write_account_profile(profile_id, refreshed, expected_revision=expected_revision)
                    self.send_json({"portfolio": saved, "errors": errors})
            except ProfileConflictError as error:
                self.send_json({"error": str(error), "portfolio": read_account_profile(self.account_profile_id())}, HTTPStatus.CONFLICT)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except Exception as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/goal-simulator":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 200_000:
                    raise ValueError("目标预测设置大小不正确")
                settings = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(settings, dict):
                    raise ValueError("目标预测设置格式不正确")
                self.send_json({"settings": write_goal_settings("owner", settings)})
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except OSError as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/local-refresh":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 2_000_000:
                    raise ValueError("本地持仓数据大小不正确")
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                holdings = data.get("holdings")
                if not isinstance(holdings, list) or len(holdings) > 50:
                    raise ValueError("本地持仓数据格式不正确")
                normalize_trade_records(data)
                data.setdefault("history", [])
                data.setdefault("fx", {})
                for holding in holdings:
                    if not isinstance(holding, dict):
                        raise ValueError("本地持仓数据格式不正确")
                    holding["id"] = str(holding.get("id") or secrets.token_urlsafe(12))
                    normalized_account = normalize_account_type(holding.get("account"))
                    holding["account"] = None if normalized_account == "未设置" else normalized_account
                    if holding.get("name") in FUND_IDS:
                        holding["fundId"] = FUND_IDS[holding["name"]]
                        holding.pop("quoteSource", None)
                    smbc_code = smbc_fund_code(holding.get("name"))
                    if smbc_code:
                        holding["smbcFundCode"] = smbc_code
                        holding.pop("quoteSource", None)
                    if holding.get("name") == "黄金":
                        holding["symbol"] = None
                        holding["quoteSource"] = "internationalGold"
                        holding["autoQuote"] = True
                refreshed, errors = refresh_quotes(data, persist=False)
                self.send_json({"portfolio": refreshed, "errors": errors})
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except Exception as error:
                self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path == "/api/portfolio":
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data.get("holdings"), list):
                    raise ValueError("持仓数据格式不正确")
                normalize_trade_records(data)
                for holding in data["holdings"]:
                    holding["id"] = str(holding.get("id") or secrets.token_urlsafe(12))
                    normalized_account = normalize_account_type(holding.get("account"))
                    holding["account"] = None if normalized_account == "未设置" else normalized_account
                    if holding.get("name") in FUND_IDS:
                        holding["fundId"] = FUND_IDS[holding["name"]]
                        holding.pop("quoteSource", None)
                    smbc_code = smbc_fund_code(holding.get("name"))
                    if smbc_code:
                        holding["smbcFundCode"] = smbc_code
                        holding.pop("quoteSource", None)
                    if holding.get("name") == "黄金":
                        holding["symbol"] = None
                        holding["quoteSource"] = "internationalGold"
                        holding["autoQuote"] = True
                data["totalAssetsJPY"] = sum(item.get("valueJPY", 0) for item in data["holdings"])
                data = write_data(data)
                QUOTE_WAKE_EVENT.set()
                STREAM_WAKE_EVENT.set()
                self.send_json(data)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if request_path != "/api/refresh":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            data, errors = refresh_quotes(read_data())
            publish_live_quotes(data, errors)
            self.send_json({"portfolio": data, "errors": errors})
        except Exception as error:
            self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)


if __name__ == "__main__":
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=quote_manager, name="quote-manager", daemon=True).start()
    threading.Thread(target=slow_quote_manager, name="slow-quote-manager", daemon=True).start()
    threading.Thread(target=load_yfinance_stream, name="yfinance-loader", daemon=True).start()
    print(f"Portfolio dashboard: http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()
