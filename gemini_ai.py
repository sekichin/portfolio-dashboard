from __future__ import annotations

import json
import math
import os
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree
from zoneinfo import ZoneInfo


class GeminiAIError(RuntimeError):
    pass


class GeminiRateLimitError(GeminiAIError):
    def __init__(self, retry_after: int | None = None):
        self.retry_after = retry_after
        message = "AI 服务请求过于频繁，请稍后再试"
        if retry_after:
            message = f"AI 服务请求过于频繁，请约 {retry_after} 秒后再试"
        super().__init__(message)


class GeminiModelUnavailableError(GeminiAIError):
    pass


PUBLIC_INTEL_CACHE_TTL_SECONDS = 15 * 60
PUBLIC_INTEL_CACHE: dict[str, tuple[float, dict]] = {}
PUBLIC_INTEL_CACHE_LOCK = threading.Lock()
GOOGLE_MODEL_CACHE: tuple[float, set[str]] | None = None
GOOGLE_MODEL_CACHE_LOCK = threading.Lock()


def _as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list:
    return value if isinstance(value, list) else []


def _error_message(detail: str) -> str:
    try:
        payload = json.loads(detail)
    except json.JSONDecodeError:
        return detail
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str) and error:
            return error
        if payload.get("message"):
            return str(payload["message"])
    if isinstance(payload, list):
        messages = [
            str(item.get("message") or item.get("error") or "")
            for item in payload
            if isinstance(item, dict)
        ]
        if any(messages):
            return "；".join(message for message in messages if message)
    return detail


def _public_json(url: str, timeout: int = 12) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; PortfolioDashboard/1.0)",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
        payload = json.load(response)
    return payload if isinstance(payload, dict) else {}


def _clean_news_text(value: object) -> str:
    text = unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:320]


def _yahoo_news(query: str, limit: int = 6) -> list[dict]:
    params = urllib.parse.urlencode({"q": query, "quotesCount": 1, "newsCount": limit})
    payload = _public_json(f"https://query1.finance.yahoo.com/v1/finance/search?{params}")
    items: list[dict] = []
    for item in payload.get("news") or []:
        if not isinstance(item, dict) or not item.get("title") or not item.get("link"):
            continue
        published_at = item.get("providerPublishTime")
        items.append({
            "title": str(item.get("title") or ""),
            "publisher": str(item.get("publisher") or "Yahoo Finance"),
            "url": str(item.get("link") or ""),
            "publishedAt": datetime.fromtimestamp(float(published_at), ZoneInfo("UTC")).isoformat() if published_at else None,
            "snippet": _clean_news_text(item.get("summary") or item.get("description") or item.get("content")),
        })
        if len(items) >= limit:
            break
    return items


def _google_news(query: str, limit: int = 6) -> list[dict]:
    params = urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    request = urllib.request.Request(
        f"https://news.google.com/rss/search?{params}",
        headers={"User-Agent": "Mozilla/5.0 (compatible; PortfolioDashboard/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=15, context=ssl.create_default_context()) as response:
        root = ElementTree.fromstring(response.read())
    items: list[dict] = []
    for item in root.findall("./channel/item"):
        title = str(item.findtext("title") or "").strip()
        link = str(item.findtext("link") or "").strip()
        if not title or not link:
            continue
        source = item.find("source")
        publisher = str(source.text or "Google News").strip() if source is not None else "Google News"
        published_text = str(item.findtext("pubDate") or "").strip()
        try:
            published_at = parsedate_to_datetime(published_text).astimezone(ZoneInfo("UTC")).isoformat()
        except (TypeError, ValueError, OverflowError):
            published_at = None
        items.append({
            "title": title,
            "publisher": publisher,
            "url": link,
            "publishedAt": published_at,
            "snippet": _clean_news_text(item.findtext("description") or ""),
        })
        if len(items) >= limit:
            break
    return items


def _latest_series_values(series: dict, field: str, limit: int = 5) -> list[dict]:
    values = series.get(field) if isinstance(series, dict) else None
    if not isinstance(values, list):
        return []
    output: list[dict] = []
    for value in values[-limit:]:
        if not isinstance(value, dict):
            continue
        reported = value.get("reportedValue") if isinstance(value.get("reportedValue"), dict) else {}
        raw = reported.get("raw")
        if raw is None:
            continue
        output.append({
            "date": value.get("asOfDate"),
            "period": value.get("periodType"),
            "value": raw,
            "formatted": reported.get("fmt"),
            "currency": value.get("currencyCode"),
        })
    return output


def _yahoo_fundamentals(symbol: str) -> dict:
    now = int(time.time())
    period1 = now - 3 * 366 * 24 * 60 * 60
    types = (
        "trailingMarketCap,trailingPeRatio,trailingForwardPeRatio,trailingPsRatio,"
        "quarterlyDilutedEPS,quarterlyTotalRevenue,quarterlyOperatingIncome"
    )
    encoded_symbol = urllib.parse.quote(symbol, safe=".")
    params = urllib.parse.urlencode({
        "symbol": symbol,
        "type": types,
        "merge": "false",
        "period1": period1,
        "period2": now + 30 * 24 * 60 * 60,
    })
    payload = _public_json(
        f"https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{encoded_symbol}?{params}"
    )
    output: dict[str, list[dict]] = {}
    for series in _as_list(_as_dict(payload.get("timeseries")).get("result")):
        if not isinstance(series, dict):
            continue
        type_value = (series.get("meta") or {}).get("type")
        field = type_value[0] if isinstance(type_value, list) and type_value else str(type_value or "")
        if field:
            values = _latest_series_values(series, field)
            if values:
                output[field] = values
    return output


def _public_holding_intelligence(holding: dict, *, include_news: bool = True) -> dict:
    symbol = str(holding.get("symbol") or "").strip().upper()
    name = str(holding.get("name") or symbol or "资产").strip()
    asset_class = str(holding.get("assetClass") or holding.get("product") or "").strip().lower()
    normalized_name = re.sub(r"[\s　・･（）()&＆._-]+", "", name).lower()
    company_aliases = {
        "8053.T": "Sumitomo Corporation",
        "5802.T": "Sumitomo Electric Industries",
    }
    company_name = company_aliases.get(symbol, name if name.upper() != symbol else symbol)
    if asset_class == "gold" or "黄金" in name or "gold" in normalized_name:
        query = "gold price dollar real yields central banks"
        fallback_query = "gold market"
    elif asset_class == "fund" or not symbol:
        if "sp500" in normalized_name or "s&p500" in name.lower():
            query = "S&P 500 market earnings interest rates"
            fallback_query = "S&P 500"
        elif "fang" in normalized_name:
            query = "NYSE FANG+ index mega cap technology stocks"
            fallback_query = "FANG+ index"
        elif "nasdaq" in normalized_name or "ナスダック" in name:
            query = "NASDAQ 100 technology stocks market"
            fallback_query = "NASDAQ 100"
        elif "topix" in normalized_name or "日経" in name:
            query = "Japan TOPIX Nikkei stocks market"
            fallback_query = "TOPIX"
        else:
            query = f'"{name}" fund index market'
            fallback_query = name
    else:
        query = f'"{company_name}" {symbol} stock earnings guidance'
        fallback_query = company_name or symbol
    result = {
        "name": name,
        "symbol": symbol,
        "news": [],
        "fundamentals": {},
        "errors": [],
    }
    if include_news:
        try:
            result["news"] = _google_news(query, 6)
        except Exception as error:
            result["errors"].append(f"google_news:{type(error).__name__}")
        if not result["news"]:
            try:
                result["news"] = _yahoo_news(fallback_query, 6)
            except Exception as fallback_error:
                result["errors"].append(f"yahoo_news:{type(fallback_error).__name__}")
    if symbol and symbol not in {"—", "-"} and not symbol.endswith("=X"):
        try:
            result["fundamentals"] = _yahoo_fundamentals(symbol)
        except Exception as error:
            result["errors"].append(f"fundamentals:{type(error).__name__}")
    return result


def _public_market_intelligence(holdings: list[dict], *, include_news: bool = True) -> dict:
    cache_key = f"news={int(include_news)}|" + "|".join(sorted({f"{item.get('symbol')}:{item.get('name')}" for item in holdings}))
    with PUBLIC_INTEL_CACHE_LOCK:
        cached = PUBLIC_INTEL_CACHE.get(cache_key)
        if cached and time.time() - cached[0] < PUBLIC_INTEL_CACHE_TTL_SECONDS:
            return cached[1]

    holding_intel: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(6, max(1, len(holdings)))) as executor:
        futures = {
            executor.submit(_public_holding_intelligence, holding, include_news=include_news): holding
            for holding in holdings
        }
        for future in as_completed(futures):
            try:
                holding_intel.append(future.result())
            except Exception:
                holding = futures[future]
                holding_intel.append({
                    "name": holding.get("name"),
                    "symbol": holding.get("symbol"),
                    "news": [],
                    "fundamentals": {},
                    "errors": ["fetch_failed"],
                })
    holding_intel.sort(key=lambda item: str(item.get("name") or ""))

    macro_queries = {
        "AI与数据中心资本开支": "AI data center capex semiconductors outlook",
        "美国利率与美债": "Federal Reserve interest rates Treasury yields market outlook",
        "日本央行与日元": "Bank of Japan yen USD JPY monetary policy",
        "黄金": "gold price real yields central bank buying outlook",
    }
    macro_news: list[dict] = []
    if include_news:
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(_google_news, query, 2): topic for topic, query in macro_queries.items()}
            for future in as_completed(futures):
                topic = futures[future]
                try:
                    for item in future.result():
                        macro_news.append({"topic": topic, **item})
                except Exception:
                    continue

    result = {
        "fetchedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "provider": "Yahoo Finance public endpoints",
        "holdings": holding_intel,
        "macroNews": macro_news,
        "limitations": "公开数据不保证覆盖全部分析师一致预期；预期市盈率仅作为市场盈利预期的估值参考。",
    }
    with PUBLIC_INTEL_CACHE_LOCK:
        PUBLIC_INTEL_CACHE[cache_key] = (time.time(), result)
    return result


def _model() -> str:
    return os.environ.get("AI_MODEL", "gemini-3.5-flash").strip() or "gemini-3.5-flash"


def _fallback_model() -> str:
    return os.environ.get("AI_FALLBACK_MODEL", "gemini-3.5-flash-lite").strip() or "gemini-3.5-flash-lite"


def configured() -> bool:
    return bool(
        os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("AI_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    )


def _api_key() -> str:
    return (
        os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("AI_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    )


def _chat_endpoint() -> str:
    base_url = os.environ.get("AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").strip().rstrip("/")
    if base_url.endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions"


def _extract_text(response: dict) -> str:
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise GeminiAIError("AI 没有返回分析结果")
    message = choices[0].get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        texts = [
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict) and item.get("text")
        ]
        if texts:
            return "\n".join(texts).strip()
    raise GeminiAIError("AI 返回内容为空")


def _extract_json(text: str) -> dict:
    cleaned = text.strip().lstrip("\ufeff")
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start = cleaned.find("{")
    if start < 0:
        raise GeminiAIError("AI 没有返回可读取的预测数据")

    depth = 0
    in_string = False
    escaped = False
    end = -1
    for index, character in enumerate(cleaned[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                end = index
                break
    truncated = end <= start
    candidate = cleaned[start:end + 1] if not truncated else cleaned[start:]
    attempts = [candidate]
    repaired = (
        candidate
        .replace("“", '"')
        .replace("”", '"')
        .replace("‘", "'")
        .replace("’", "'")
    )
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    repaired = re.sub(r'([}"\]0-9])\s*\n\s*("[^"\n]+"\s*:)', r"\1,\2", repaired)
    repaired = re.sub(r'([}\]])\s*\n\s*([\[{])', r"\1,\2", repaired)
    repaired = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", repaired)
    if repaired != candidate:
        attempts.append(repaired)
    if truncated:
        completed = repaired.rstrip()
        stack: list[str] = []
        in_string = False
        escaped = False
        for character in completed:
            if in_string:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    in_string = False
                continue
            if character == '"':
                in_string = True
            elif character == "{":
                stack.append("}")
            elif character == "[":
                stack.append("]")
            elif character in "}]" and stack and stack[-1] == character:
                stack.pop()
        if in_string:
            completed += '"'
        stripped = completed.rstrip()
        if stripped.endswith(":"):
            completed += "null"
        elif stripped.endswith(","):
            completed = stripped[:-1]
        completed += "".join(reversed(stack))
        attempts.append(completed)

    last_error = None
    for value in attempts:
        try:
            parsed = json.loads(value, strict=False)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError as error:
            last_error = error
    message = last_error.msg if last_error else "根节点不是对象"
    raise GeminiAIError(f"AI 预测数据格式不正确：{message}") from last_error


def _sources(response: dict) -> list[dict]:
    sources: list[dict] = []
    seen: set[str] = set()

    def visit(value: object) -> None:
        if isinstance(value, dict):
            url = str(value.get("url") or value.get("uri") or "").strip()
            if url.startswith(("http://", "https://")) and url not in seen:
                seen.add(url)
                sources.append({
                    "title": str(value.get("title") or value.get("name") or urllib.parse.urlparse(url).netloc),
                    "url": url,
                })
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(response.get("steps") if isinstance(response, dict) else response)
    return sources[:16]


def _google_native_enabled() -> bool:
    base_url = os.environ.get(
        "AI_BASE_URL",
        "https://generativelanguage.googleapis.com/v1beta/openai",
    ).strip().lower()
    return bool(os.environ.get("GEMINI_API_KEY", "").strip()) or "generativelanguage.googleapis.com" in base_url


def _available_google_models() -> set[str]:
    global GOOGLE_MODEL_CACHE
    with GOOGLE_MODEL_CACHE_LOCK:
        if GOOGLE_MODEL_CACHE and time.time() - GOOGLE_MODEL_CACHE[0] < 10 * 60:
            return set(GOOGLE_MODEL_CACHE[1])
    request = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        headers={"Accept": "application/json", "x-goog-api-key": _api_key()},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise GeminiAIError(f"读取 Gemini 可用模型失败：{_error_message(detail)}") from error
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as error:
        raise GeminiAIError(f"读取 Gemini 可用模型失败：{error}") from error
    models = {
        str(item.get("name") or "").removeprefix("models/")
        for item in payload.get("models") or []
        if isinstance(item, dict)
        and "generateContent" in (item.get("supportedGenerationMethods") or [])
    }
    with GOOGLE_MODEL_CACHE_LOCK:
        GOOGLE_MODEL_CACHE = (time.time(), set(models))
    return models


def _interaction_text(response: dict) -> str:
    direct = response.get("output_text") or response.get("outputText")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    steps = response.get("steps") if isinstance(response, dict) else None
    if isinstance(steps, list):
        for step in reversed(steps):
            if not isinstance(step, dict) or step.get("type") != "model_output":
                continue
            content = step.get("content")
            if not isinstance(content, list):
                continue
            texts = [
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text" and item.get("text")
            ]
            if texts:
                return "\n".join(texts).strip()
    raise GeminiAIError("AI 返回内容为空")


def _native_interaction_request(
    prompt: str,
    *,
    model: str,
    grounded: bool,
    schema: dict | None,
    timeout: int,
    max_output_tokens: int,
) -> tuple[dict, list[dict]]:
    payload: dict = {
        "model": model,
        "system_instruction": (
            "你是严谨的投资组合预测与分析引擎。必须先使用 Google Search 核验最新公开资料，再进行判断。"
            if grounded
            else "你是严谨的投资组合预测与分析引擎。"
        ) + "输出必须是 RFC 8259 合法 JSON，不得输出 Markdown、注释或 JSON 之外的文字。",
        "input": prompt,
        "generation_config": {
            "thinking_level": "high",
            "max_output_tokens": max_output_tokens,
        },
    }
    if grounded:
        payload["tools"] = [{"type": "google_search"}, {"type": "url_context"}]
    if schema:
        payload["response_format"] = {
            "type": "text",
            "mime_type": "application/json",
            "schema": schema,
        }
    endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions"

    for transport_attempt in range(3):
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": _api_key()},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise GeminiAIError("AI 没有返回分析结果")
            parsed = _extract_json(_interaction_text(result))
            parsed["_usedModel"] = model
            return parsed, _sources(result)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            message = _error_message(detail)
            normalized_message = str(message).lower()
            if error.code == 429:
                delay_match = re.search(r"retry in\s+([0-9.]+)s", str(message), flags=re.IGNORECASE)
                retry_header = error.headers.get("Retry-After") if error.headers else None
                retry_after = math.ceil(float(delay_match.group(1))) if delay_match else None
                if retry_after is None and retry_header:
                    try:
                        retry_after = math.ceil(float(retry_header))
                    except ValueError:
                        retry_after = None
                raise GeminiRateLimitError(retry_after) from error
            if error.code == 400 and "response_format" in payload and any(
                marker in normalized_message for marker in ("schema", "response_format", "too complex")
            ):
                payload.pop("response_format", None)
                continue
            if error.code == 503 and transport_attempt < 2:
                time.sleep(2 * (transport_attempt + 1))
                continue
            if error.code == 503 or (
                error.code in {400, 404, 422, 502}
                and any(marker in normalized_message for marker in ("model", "unavailable", "not found", "high demand"))
            ):
                raise GeminiModelUnavailableError(f"模型 {model} 暂时不可用") from error
            raise GeminiAIError(f"AI 请求失败：{message}") from error
        except urllib.error.URLError as error:
            if _is_connection_timeout(error) and transport_attempt == 0:
                time.sleep(0.5)
                continue
            if _is_connection_timeout(error):
                raise GeminiAIError("AI 服务连接超时，已自动重试一次仍未连上，请稍后再试") from error
            raise GeminiAIError(f"AI 连接失败：{error}") from error
        except (TimeoutError, socket.timeout) as error:
            if transport_attempt == 0:
                time.sleep(0.5)
                continue
            raise GeminiAIError("AI 分析生成超时，请稍后再试") from error
        except OSError as error:
            if _is_connection_timeout(error) and transport_attempt == 0:
                time.sleep(0.5)
                continue
            raise GeminiAIError(f"AI 连接失败：{error}") from error
        except json.JSONDecodeError as error:
            raise GeminiAIError(f"AI 返回数据无法读取：{error}") from error

    raise GeminiAIError("AI 请求失败")


def _native_generate_content_request(
    prompt: str,
    *,
    model: str,
    schema: dict | None,
    timeout: int,
    max_output_tokens: int,
) -> tuple[dict, list[dict]]:
    generation_config: dict = {
        "temperature": 0.15,
        "maxOutputTokens": max_output_tokens,
        "responseMimeType": "application/json",
    }
    if schema:
        generation_config["responseSchema"] = schema
    payload = {
        "systemInstruction": {
            "parts": [{
                "text": "你是严谨的投资组合预测与分析引擎。输出必须是 RFC 8259 合法 JSON，不得输出 Markdown、注释或 JSON 之外的文字。",
            }],
        },
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": generation_config,
    }
    encoded_model = urllib.parse.quote(model, safe="-._")
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{encoded_model}:generateContent"
    for transport_attempt in range(2):
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": _api_key()},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            candidates = result.get("candidates") if isinstance(result, dict) else None
            parts = (((candidates or [{}])[0].get("content") or {}).get("parts") or [])
            text = "\n".join(
                str(part.get("text") or "")
                for part in parts
                if isinstance(part, dict) and part.get("text")
            ).strip()
            if not text:
                raise GeminiAIError("AI 返回内容为空")
            parsed = _extract_json(text)
            parsed["_usedModel"] = model
            return parsed, []
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            message = _error_message(detail)
            if error.code == 429:
                retry_header = error.headers.get("Retry-After") if error.headers else None
                try:
                    retry_after = math.ceil(float(retry_header)) if retry_header else None
                except ValueError:
                    retry_after = None
                raise GeminiRateLimitError(retry_after) from error
            if error.code == 400 and schema and any(marker in str(message).lower() for marker in ("schema", "responseschema")):
                generation_config.pop("responseSchema", None)
                schema = None
                continue
            if error.code == 404:
                raise GeminiAIError(f"Gemini 404：{message}") from error
            if error.code in {422, 502, 503}:
                raise GeminiModelUnavailableError(f"模型 {model} 暂时不可用") from error
            raise GeminiAIError(f"AI 请求失败：{message}") from error
        except urllib.error.URLError as error:
            if _is_connection_timeout(error) and transport_attempt == 0:
                time.sleep(0.5)
                continue
            raise GeminiAIError(f"AI 连接失败：{error}") from error
        except (TimeoutError, socket.timeout) as error:
            if transport_attempt == 0:
                time.sleep(0.5)
                continue
            raise GeminiAIError("AI 分析生成超时，请稍后再试") from error
        except json.JSONDecodeError as error:
            raise GeminiAIError(f"AI 返回数据无法读取：{error}") from error
    raise GeminiAIError("AI 请求失败")


def _is_connection_timeout(error: BaseException) -> bool:
    reason = getattr(error, "reason", error)
    return getattr(reason, "errno", None) in {60, 110}


def _generate_with_model(
    prompt: str,
    *,
    model: str,
    grounded: bool,
    schema: dict | None = None,
    timeout: int = 52,
    max_output_tokens: int = 4096,
    attempts: int = 1,
) -> tuple[dict, list[dict]]:
    api_key = _api_key()
    if not api_key:
        raise GeminiAIError("AI API 尚未配置")
    if _google_native_enabled():
        if grounded or model.startswith("gemini-3.8"):
            return _native_interaction_request(
                prompt,
                model=model,
                grounded=grounded,
                schema=schema,
                timeout=timeout,
                max_output_tokens=max_output_tokens,
            )
        return _native_generate_content_request(
            prompt,
            model=model,
            schema=schema,
            timeout=timeout,
            max_output_tokens=max_output_tokens,
        )
    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你是严谨的投资组合预测与分析引擎。输出必须是 RFC 8259 合法 JSON：所有键和字符串必须使用英文双引号；不得输出 Markdown、注释或 JSON 之外的文字。JSON 仅是数据传输格式，不代表分析必须简短。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.15,
        "reasoning_effort": "low",
        "max_tokens": max_output_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    endpoint = _chat_endpoint()
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    for transport_attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise GeminiAIError("AI 没有返回分析结果")
            parsed = _extract_json(_extract_text(result))
            parsed["_usedModel"] = model
            return parsed, _sources(result)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            message = _error_message(detail)
            normalized_message = str(message).lower()
            if error.code == 429 and "多次请求失败" in normalized_message:
                raise GeminiModelUnavailableError(f"模型 {model} 暂时不可用") from error
            if error.code == 429:
                delay_match = re.search(r"retry in\s+([0-9.]+)s", str(message), flags=re.IGNORECASE)
                retry_header = error.headers.get("Retry-After") if error.headers else None
                retry_after = math.ceil(float(delay_match.group(1))) if delay_match else None
                if retry_after is None and retry_header:
                    try:
                        retry_after = math.ceil(float(retry_header))
                    except ValueError:
                        retry_after = None
                raise GeminiRateLimitError(retry_after) from error
            if error.code == 400 and "response_format" in normalized_message:
                payload.pop("response_format", None)
                request = urllib.request.Request(
                    endpoint,
                    data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                    method="POST",
                )
                continue
            model_failure = error.code in {400, 404, 422, 502, 503} and any(
                marker in normalized_message
                for marker in ("model", "模型", "unavailable", "not found", "多次请求失败")
            )
            if model_failure:
                raise GeminiModelUnavailableError(f"模型 {model} 暂时不可用") from error
            raise GeminiAIError(f"AI 请求失败：{message}") from error
        except urllib.error.URLError as error:
            if _is_connection_timeout(error) and transport_attempt == 0:
                time.sleep(0.5)
                continue
            if _is_connection_timeout(error):
                raise GeminiAIError("AI 服务连接超时，已自动重试一次仍未连上，请稍后再试") from error
            raise GeminiAIError(f"AI 连接失败：{error}") from error
        except (TimeoutError, socket.timeout) as error:
            raise GeminiAIError("AI 分析生成超时，请稍后再试") from error
        except OSError as error:
            if _is_connection_timeout(error) and transport_attempt == 0:
                time.sleep(0.5)
                continue
            if _is_connection_timeout(error):
                raise GeminiAIError("AI 服务连接超时，已自动重试一次仍未连上，请稍后再试") from error
            raise GeminiAIError(f"AI 连接失败：{error}") from error
        except json.JSONDecodeError as error:
            raise GeminiAIError(f"AI 返回数据无法读取：{error}") from error


def _generate(
    prompt: str,
    *,
    grounded: bool,
    schema: dict | None = None,
    timeout: int = 52,
    max_output_tokens: int = 4096,
    attempts: int = 1,
) -> tuple[dict, list[dict]]:
    models = list(dict.fromkeys((
        _model(),
        _fallback_model(),
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
    )))
    if _google_native_enabled():
        available_models = _available_google_models()
        matched_models = [model for model in models if model in available_models]
        if not matched_models:
            visible_models = sorted(model for model in available_models if "flash" in model)[-12:]
            raise GeminiAIError(f"当前 API 项目未开放所需模型；可用 Flash 模型：{', '.join(visible_models) or '无'}")
        models = matched_models
    failures: list[GeminiAIError] = []
    for model in models:
        try:
            return _generate_with_model(
                prompt,
                model=model,
                grounded=grounded,
                schema=schema,
                timeout=timeout,
                max_output_tokens=max_output_tokens,
                attempts=attempts,
            )
        except (GeminiModelUnavailableError, GeminiRateLimitError) as error:
            failures.append(error)
            continue
    rate_limits = [error for error in failures if isinstance(error, GeminiRateLimitError)]
    if rate_limits:
        retry_after = max((error.retry_after or 0 for error in rate_limits), default=0) or None
        raise GeminiRateLimitError(retry_after) from rate_limits[-1]
    if failures:
        raise failures[-1]
    raise GeminiAIError("AI 请求失败")


def check_connection() -> dict:
    """Send a minimal authenticated request to verify provider connectivity."""
    available_models = sorted(_available_google_models()) if _google_native_enabled() else []
    result, _ = _generate(
        '仅返回 JSON：{"ok":true}',
        grounded=False,
        timeout=25,
        max_output_tokens=1024,
    )
    if result.get("ok") is not True:
        raise GeminiAIError("AI 服务未返回连通确认")
    return {
        "ok": True,
        "model": str(result.get("_usedModel") or _model()),
        "availableModels": available_models,
    }


def _holding_asset_class(holding: dict) -> str:
    name = str(holding.get("name") or "").lower()
    account = str(holding.get("account") or "").lower()
    market = str(holding.get("market") or "").upper()
    if "黄金" in name or "gold" in name or "黄金" in account:
        return "gold"
    if "现金" in name or "cash" in name:
        return "cash"
    if holding.get("fundId") or (not holding.get("symbol") and market == "JP"):
        return "fund"
    if market == "US":
        return "us"
    if market == "JP":
        return "jp"
    return "other"


def _holding_category(holding: dict) -> str:
    asset_class = _holding_asset_class(holding)
    name = str(holding.get("name") or "").lower()
    symbol = str(holding.get("symbol") or "").upper()
    if asset_class == "fund":
        if any(value in name for value in ("fang", "nasdaq", "ナスダック")):
            return "growth_index_fund"
        if any(value in name for value in ("全世界", "オール", "msci", "全球", "global")):
            return "global_equity_fund"
        return "us_index_fund" if any(value in name for value in ("s&p", "sp500", "米国")) else "index_fund"
    if asset_class == "gold":
        return "gold"
    if asset_class == "cash":
        return "cash"
    if asset_class == "jp":
        return "japan_stock"
    return "listed_stock"


def _holding_summary(portfolio: dict) -> list[dict]:
    holdings: list[dict] = []
    fx_rate = float(_as_dict(_as_dict(portfolio.get("fx")).get("USDJPY")).get("price") or 1)
    for holding in _as_list(portfolio.get("holdings")):
        if not isinstance(holding, dict) or holding.get("archived"):
            continue
        quote = holding.get("quote") if isinstance(holding.get("quote"), dict) else {}
        units = float(holding.get("units") or 0)
        quote_price = float(quote.get("price") or 0)
        value = float(holding.get("valueJPY") or 0)
        if quote_price > 0 and units > 0:
            if quote.get("currency") == "USD":
                value = quote_price * units * fx_rate
            else:
                scale = 10000 if holding.get("fundId") or (not holding.get("symbol") and holding.get("market") == "JP" and holding.get("name") != "黄金") else 1
                value = quote_price * units / scale
        buy_price = float(holding.get("buyPrice") or holding.get("avgCost") or 0)
        cost = buy_price * units
        if holding.get("fundId") or (not holding.get("symbol") and holding.get("market") == "JP" and holding.get("name") != "黄金"):
            cost /= 10000
        if cost <= 0:
            cost = max(0, value - float(holding.get("profitJPY") or 0))
        holdings.append({
            "holdingId": str(holding.get("id") or holding.get("symbol") or holding.get("name") or ""),
            "name": str(holding.get("name") or holding.get("symbol") or "未命名"),
            "symbol": str(holding.get("symbol") or ""),
            "market": str(holding.get("market") or ""),
            "account": str(holding.get("account") or "未设置"),
            "assetClass": _holding_asset_class(holding),
            "category": _holding_category(holding),
            "valueJPY": round(value),
            "costJPY": round(cost),
            "profitJPY": round(value - cost),
            "profitRatePct": round((value - cost) / cost * 100, 2) if cost else 0,
            "dayChangePct": quote.get("changePct"),
            "latestPrice": quote.get("price"),
            "currency": quote.get("currency"),
        })
    return holdings


DAILY_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "changeNature": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "label": {"type": "string"},
                    "metrics": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "required": ["label", "value"],
                        },
                    },
                    "analysis": {"type": "string"},
                },
                "required": ["name", "label", "metrics", "analysis"],
            },
        },
        "logicChanges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "direction": {"type": "string", "enum": ["增强", "转弱", "失效"]},
                    "reason": {"type": "string"},
                    "verification": {"type": "string"},
                },
                "required": ["name", "direction", "reason", "verification"],
            },
        },
        "actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "changeNature", "logicChanges", "actions"],
}


def _daily_record(portfolio: dict, date_text: str) -> dict:
    for record in _as_list(portfolio.get("history")):
        if isinstance(record, dict) and str(record.get("date") or "") == date_text:
            return record
    raise ValueError("所选日期没有收益记录")


def _historical_benchmark_key(
    history: list[dict],
    date_text: str,
    holding_name: str,
    candidates: tuple[str, ...],
) -> tuple[str | None, str]:
    series: dict[str, list[tuple[float, float]]] = {key: [] for key in candidates}
    for record in history:
        if not isinstance(record, dict) or str(record.get("date") or "") >= date_text:
            continue
        holding_values = _as_dict(_as_dict(record.get("breakdown")).get("holding")).get(holding_name)
        holding_values = _as_dict(holding_values)
        holding_return = holding_values.get("dailyProfitRate", holding_values.get("dailyReturnRate"))
        if holding_return is None:
            continue
        try:
            holding_return_value = float(holding_return)
        except (TypeError, ValueError):
            continue
        benchmarks = _as_dict(record.get("benchmarkReturns"))
        for key in candidates:
            try:
                benchmark_return = float(benchmarks.get(key))
            except (TypeError, ValueError):
                continue
            if math.isfinite(holding_return_value) and math.isfinite(benchmark_return):
                series[key].append((holding_return_value, benchmark_return))

    correlations: dict[str, float] = {}
    for key, pairs in series.items():
        pairs = pairs[-60:]
        if len(pairs) < 10:
            continue
        holding_mean = sum(pair[0] for pair in pairs) / len(pairs)
        benchmark_mean = sum(pair[1] for pair in pairs) / len(pairs)
        covariance = sum((pair[0] - holding_mean) * (pair[1] - benchmark_mean) for pair in pairs)
        holding_variance = sum((pair[0] - holding_mean) ** 2 for pair in pairs)
        benchmark_variance = sum((pair[1] - benchmark_mean) ** 2 for pair in pairs)
        denominator = math.sqrt(holding_variance * benchmark_variance)
        if denominator > 0:
            correlations[key] = covariance / denominator
    if not correlations:
        return None, "历史样本不足，使用资产类型默认基准"
    best_key = max(correlations, key=correlations.get)
    return best_key, f"根据最近最多60个共同交易日的收益联动性选择（相关系数{correlations[best_key]:.2f}）"


def _daily_benchmark_key(
    holding: dict,
    history: list[dict] | None = None,
    date_text: str = "",
    holding_name: str = "",
) -> tuple[str | None, str]:
    asset_class = str(holding.get("assetClass") or "")
    name = str(holding.get("name") or "").lower()
    normalized_name = re.sub(r"[\s　・･（）()&＆._-]+", "", name)
    if any(marker in normalized_name for marker in ("日経225", "日経２２５", "topix", "国内株式")):
        return "topix", "日本股票或日本股票指数使用TOPIX"
    if asset_class == "jp":
        return "topix", "日本股票使用TOPIX"
    if asset_class == "gold":
        return None, "黄金不与股票指数直接比较"
    if "fang" in name or "nasdaq" in name or "ナスダック" in name:
        return "nasdaq100", "成长型或NASDAQ相关产品使用NASDAQ-100"
    if asset_class == "fund":
        return "sp500", "美国或全球股票基金默认使用S&P500"
    if asset_class == "us":
        historical_key, reason = _historical_benchmark_key(
            history or [], date_text, holding_name or str(holding.get("name") or ""), ("sp500", "nasdaq100")
        )
        return historical_key or "sp500", reason
    return None, "没有适用的股票指数基准"


def _daily_anomaly_percentile(history: list[dict], date_text: str, holding_name: str, current_return: float) -> int | None:
    prior_returns: list[float] = []
    for record in history:
        if not isinstance(record, dict) or str(record.get("date") or "") >= date_text:
            continue
        values = _as_dict(_as_dict(record.get("breakdown")).get("holding")).get(holding_name)
        values = _as_dict(values)
        daily_return = values.get("dailyProfitRate", values.get("dailyReturnRate"))
        if daily_return is None:
            continue
        try:
            daily_return_value = abs(float(daily_return))
        except (TypeError, ValueError):
            continue
        if math.isfinite(daily_return_value):
            prior_returns.append(daily_return_value)
    prior_returns = prior_returns[-60:]
    if len(prior_returns) < 10:
        return None
    current_absolute = abs(current_return)
    return round(sum(value <= current_absolute for value in prior_returns) / len(prior_returns) * 100)


def _daily_relevant_intelligence(public_intelligence: dict, date_text: str) -> dict:
    try:
        selected_date = datetime.fromisoformat(date_text).date()
    except ValueError:
        selected_date = datetime.now(ZoneInfo("Asia/Tokyo")).date()

    def near_selected_date(item: object) -> bool:
        published_at = str(_as_dict(item).get("publishedAt") or "")
        if not published_at:
            return False
        try:
            published_date = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
        except ValueError:
            return False
        distance = (published_date - selected_date).days
        return -14 <= distance <= 3

    def sorted_series(fundamentals: dict, key: str) -> list[dict]:
        return sorted(
            [_as_dict(value) for value in _as_list(fundamentals.get(key)) if _as_dict(value).get("date")],
            key=lambda value: str(value.get("date") or ""),
        )

    def percentage_change(current: float, previous: float) -> float | None:
        if not previous:
            return None
        return (current / previous - 1) * 100

    def compact_number(value: float, currency: str = "") -> str:
        absolute = abs(value)
        if absolute >= 1_000_000_000_000:
            text = f"{value / 1_000_000_000_000:.2f}万亿"
        elif absolute >= 100_000_000:
            text = f"{value / 100_000_000:.2f}亿"
        elif absolute >= 10_000:
            text = f"{value / 10_000:.2f}万"
        else:
            text = f"{value:,.2f}"
        return f"{text}{currency}" if currency else text

    def fundamental_facts(fundamentals: dict) -> list[str]:
        facts: list[str] = []
        revenue = sorted_series(fundamentals, "quarterlyTotalRevenue")
        eps = sorted_series(fundamentals, "quarterlyDilutedEPS")
        operating_income = sorted_series(fundamentals, "quarterlyOperatingIncome")
        if revenue:
            latest = revenue[-1]
            latest_value = float(latest.get("value") or 0)
            comparison = revenue[-5] if len(revenue) >= 5 else revenue[-2] if len(revenue) >= 2 else None
            growth = percentage_change(latest_value, float(_as_dict(comparison).get("value") or 0)) if comparison else None
            period_label = "同比" if len(revenue) >= 5 else "环比"
            growth_text = f"，{period_label}{growth:+.1f}%" if growth is not None else ""
            facts.append(
                f"截至{latest.get('date')}的季度营收为{compact_number(latest_value, str(latest.get('currency') or ''))}{growth_text}"
            )
        if eps:
            latest = eps[-1]
            latest_value = float(latest.get("value") or 0)
            comparison = eps[-5] if len(eps) >= 5 else eps[-2] if len(eps) >= 2 else None
            change = latest_value - float(_as_dict(comparison).get("value") or 0) if comparison else None
            period_label = "同比" if len(eps) >= 5 else "环比"
            change_text = f"，{period_label}{change:+.2f}" if change is not None else ""
            facts.append(f"截至{latest.get('date')}的季度每股收益为{latest_value:.2f}{change_text}")
        if revenue and operating_income:
            revenue_by_date = {str(item.get("date") or ""): float(item.get("value") or 0) for item in revenue}
            margin_points = []
            for item in operating_income:
                date_key = str(item.get("date") or "")
                revenue_value = revenue_by_date.get(date_key)
                if revenue_value:
                    margin_points.append((date_key, float(item.get("value") or 0) / revenue_value * 100))
            if margin_points:
                latest_date, latest_margin = margin_points[-1]
                comparison = margin_points[-5] if len(margin_points) >= 5 else margin_points[-2] if len(margin_points) >= 2 else None
                change_text = f"，较比较期{latest_margin - comparison[1]:+.1f}个百分点" if comparison else ""
                facts.append(f"截至{latest_date}的经营利润率约{latest_margin:.1f}%{change_text}")
        trailing_pe = sorted_series(fundamentals, "trailingPeRatio")
        forward_pe = sorted_series(fundamentals, "trailingForwardPeRatio")
        valuation = []
        if trailing_pe:
            valuation.append(f"当前市盈率约{float(trailing_pe[-1].get('value') or 0):.1f}倍")
        if forward_pe:
            valuation.append(f"预期市盈率约{float(forward_pe[-1].get('value') or 0):.1f}倍")
        if valuation:
            facts.append("，".join(valuation))
        return facts[:4]

    holdings: list[dict] = []
    for item in _as_list(_as_dict(public_intelligence).get("holdings")):
        item = _as_dict(item)
        news = [news_item for news_item in _as_list(item.get("news")) if near_selected_date(news_item)]
        fundamentals = _as_dict(item.get("fundamentals"))
        holdings.append({
            "name": str(item.get("name") or ""),
            "symbol": str(item.get("symbol") or ""),
            "news": [
                {
                    "title": str(_as_dict(news_item).get("title") or ""),
                    "publisher": str(_as_dict(news_item).get("publisher") or "公开信息"),
                    "publishedAt": str(_as_dict(news_item).get("publishedAt") or ""),
                    "snippet": _clean_news_text(_as_dict(news_item).get("snippet") or ""),
                }
                for news_item in news[:6]
            ],
            "fundamentalFacts": fundamental_facts(fundamentals),
            "errors": [str(error) for error in _as_list(item.get("errors"))],
        })
    macro_news = [
        {
            "topic": str(_as_dict(item).get("topic") or ""),
            "title": str(_as_dict(item).get("title") or ""),
            "publisher": str(_as_dict(item).get("publisher") or "公开信息"),
            "publishedAt": str(_as_dict(item).get("publishedAt") or ""),
            "snippet": _clean_news_text(_as_dict(item).get("snippet") or ""),
        }
        for item in _as_list(_as_dict(public_intelligence).get("macroNews"))
        if near_selected_date(item)
    ]
    return {"holdings": holdings, "macroNews": macro_news}


def _daily_analysis_context(portfolio: dict, date_text: str) -> dict:
    record = _daily_record(portfolio, date_text)
    history = [item for item in _as_list(portfolio.get("history")) if isinstance(item, dict)]
    holding_summaries = _holding_summary(portfolio)
    current_by_name = {str(item.get("name") or ""): item for item in holding_summaries}
    holding_breakdown = _as_dict(_as_dict(record.get("breakdown")).get("holding"))
    def normalized_name(value: object) -> str:
        return re.sub(r"[\s　・･（）()&＆._-]+", "", str(value or "")).lower()

    updated_holdings = {
        normalized_name(name) for name in _as_list(record.get("updatedHoldings")) if normalized_name(name)
    }
    benchmark_returns = _as_dict(record.get("benchmarkReturns"))
    benchmark_labels = {"sp500": "S&P500", "nasdaq100": "NASDAQ-100", "topix": "TOPIX"}
    holdings: list[dict] = []
    for name, raw_values in holding_breakdown.items():
        if name == "预存款与现金" or name not in current_by_name:
            continue
        values = _as_dict(raw_values)
        try:
            profit = float(values.get("dailyProfitJPY") or 0)
            daily_return = float(values.get("dailyProfitRate", values.get("dailyReturnRate")) or 0)
            closing_value = float(values.get("totalNetAsset") or values.get("totalAssetsJPY") or 0)
            fx_impact = float(values.get("dailyFxImpactJPY") or 0)
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (profit, daily_return, closing_value, fx_impact)):
            continue
        if not updated_holdings and round(profit) == 0:
            continue
        holding = current_by_name[name]
        if updated_holdings and not {
            normalized_name(name),
            normalized_name(holding.get("symbol")),
        }.intersection(updated_holdings):
            continue
        benchmark_key, benchmark_reason = _daily_benchmark_key(holding, history, date_text, name)
        benchmark_return = benchmark_returns.get(benchmark_key) if benchmark_key else None
        try:
            benchmark_return_value = float(benchmark_return) if benchmark_return is not None else None
        except (TypeError, ValueError):
            benchmark_return_value = None
        inferred_return_base = profit / daily_return if abs(daily_return) > 1e-12 else closing_value - profit
        if not math.isfinite(inferred_return_base) or inferred_return_base <= 0:
            inferred_return_base = max(closing_value - profit, 0)
        asset_class = str(holding.get("assetClass") or "")
        if asset_class == "jp":
            fx_impact = 0
        has_fx_exposure = asset_class != "jp" and abs(fx_impact) >= 0.5
        holdings.append({
            "name": name,
            "symbol": str(holding.get("symbol") or ""),
            "product": asset_class,
            "market": str(holding.get("market") or ""),
            "currency": str(holding.get("currency") or ""),
            "account": str(holding.get("account") or ""),
            "dailyProfitJPY": round(profit),
            "dailyReturnPct": round(daily_return * 100, 2),
            "closingValueJPY": round(closing_value),
            "dailyFxImpactJPY": round(fx_impact),
            "hasFxExposure": has_fx_exposure,
            "benchmark": benchmark_labels.get(benchmark_key, "") if benchmark_key else "",
            "benchmarkSelectionReason": benchmark_reason,
            "benchmarkReturnPct": round(benchmark_return_value * 100, 2) if benchmark_return_value is not None else None,
            "relativePctPoints": round((daily_return - benchmark_return_value) * 100, 2) if benchmark_return_value is not None else None,
            "anomalyPercentile": _daily_anomaly_percentile(history, date_text, name, daily_return),
            "_returnBaseJPY": inferred_return_base,
        })
    holdings.sort(key=lambda item: abs(float(item.get("dailyProfitJPY") or 0)), reverse=True)
    filtered_profit = sum(float(item.get("dailyProfitJPY") or 0) for item in holdings)
    filtered_assets = sum(float(item.get("closingValueJPY") or 0) for item in holdings)
    filtered_fx_impact = sum(float(item.get("dailyFxImpactJPY") or 0) for item in holdings)
    filtered_return_base = sum(float(item.get("_returnBaseJPY") or 0) for item in holdings)
    total_profit = round(filtered_profit if holdings else float(record.get("dailyProfitJPY") or 0))
    closing_assets = round(filtered_assets if holdings else float(record.get("totalNetAsset") or record.get("totalAssetsJPY") or 0))
    portfolio_return = total_profit / filtered_return_base * 100 if filtered_return_base > 0 else 0
    up_count = sum(float(item.get("dailyProfitJPY") or 0) > 0 for item in holdings)
    down_count = sum(float(item.get("dailyProfitJPY") or 0) < 0 for item in holdings)
    flat_count = len(holdings) - up_count - down_count
    product_labels = {"us": "美股", "jp": "日股", "fund": "基金", "gold": "黄金", "cash": "现金"}
    product_totals: dict[str, dict[str, float]] = {}
    for item in holdings:
        product_key = str(item.get("product") or "未分类").lower()
        product_name = product_labels.get(product_key, str(item.get("product") or "未分类"))
        total = product_totals.setdefault(product_name, {"profit": 0, "fx": 0, "base": 0})
        total["profit"] += float(item.get("dailyProfitJPY") or 0)
        total["fx"] += float(item.get("dailyFxImpactJPY") or 0)
        total["base"] += float(item.get("_returnBaseJPY") or 0)
    products = [{
        "name": name,
        "dailyProfitJPY": round(values["profit"]),
        "dailyReturnPct": round(values["profit"] / values["base"] * 100, 2) if values["base"] > 0 else 0,
        "dailyFxImpactJPY": round(values["fx"]),
    } for name, values in product_totals.items()]
    products.sort(key=lambda item: abs(float(item.get("dailyProfitJPY") or 0)), reverse=True)
    public_holdings = [{key: value for key, value in item.items() if not key.startswith("_")} for item in holdings]
    return {
        "date": date_text,
        "portfolio": {
            "dailyProfitJPY": total_profit,
            "dailyReturnPct": round(portfolio_return, 2),
            "closingAssetsJPY": closing_assets,
            "dailyFxImpactJPY": round(filtered_fx_impact if holdings else float(record.get("dailyFxImpactJPY") or 0)),
            "upCount": up_count,
            "downCount": down_count,
            "flatCount": flat_count,
        },
        "benchmarks": {
            key: round(float(value) * 100, 2)
            for key, value in benchmark_returns.items()
            if value is not None
        },
        "products": products,
        "holdings": public_holdings,
        "investmentPlan": str(portfolio.get("investmentPlan") or ""),
    }


def resolve_daily_summary_date(portfolio: dict, requested_date: str) -> str:
    candidates = sorted(
        {
            str(record.get("date") or "")
            for record in _as_list(portfolio.get("history"))
            if isinstance(record, dict)
            and str(record.get("date") or "")
            and str(record.get("date") or "") <= requested_date
        },
        reverse=True,
    )
    for date_text in candidates:
        try:
            context = _daily_analysis_context(portfolio, date_text)
        except (TypeError, ValueError):
            continue
        if any(round(float(holding.get("dailyProfitJPY") or 0)) != 0 for holding in context.get("holdings", [])):
            return date_text
    raise ValueError("所选日期之前没有可分析的持仓更新")


def build_daily_portfolio_summary(portfolio: dict, date_text: str) -> dict:
    context = _daily_analysis_context(portfolio, date_text)
    important_holdings = context["holdings"][:12]
    allowed_daily_names = {
        re.sub(r"[\s　・･（）()&＆._-]+", "", str(value or "")).lower()
        for holding in context["holdings"]
        for value in (holding.get("name"), holding.get("symbol"))
        if str(value or "").strip()
    }

    def is_allowed_daily_holding(value: object) -> bool:
        normalized = re.sub(r"[\s　・･（）()&＆._-]+", "", str(value or "")).lower()
        return bool(normalized) and any(
            normalized == allowed or normalized in allowed or allowed in normalized
            for allowed in allowed_daily_names
        )

    public_intelligence = _daily_relevant_intelligence(
        _public_market_intelligence(important_holdings, include_news=True),
        date_text,
    ) if important_holdings else {"holdings": [], "macroNews": []}

    def matching_intelligence(value: object) -> dict:
        normalized = re.sub(r"[\s　・･（）()&＆._-]+", "", str(value or "")).lower()
        for item in _as_list(public_intelligence.get("holdings")):
            item = _as_dict(item)
            candidates = {
                re.sub(r"[\s　・･（）()&＆._-]+", "", str(candidate or "")).lower()
                for candidate in (item.get("name"), item.get("symbol"))
                if str(candidate or "").strip()
            }
            if any(normalized == candidate or normalized in candidate or candidate in normalized for candidate in candidates):
                return item
        return {}

    def supporting_evidence(value: object) -> tuple[list[str], list[dict]]:
        item = matching_intelligence(value)
        facts = [str(fact) for fact in _as_list(item.get("fundamentalFacts")) if str(fact).strip()]
        return facts, []

    def daily_holding(value: object) -> dict:
        normalized = re.sub(r"[\s　・･（）()&＆._-]+", "", str(value or "")).lower()
        for holding in context["holdings"]:
            candidates = {
                re.sub(r"[\s　・･（）()&＆._-]+", "", str(candidate or "")).lower()
                for candidate in (holding.get("name"), holding.get("symbol"))
                if str(candidate or "").strip()
            }
            if any(normalized == candidate or normalized in candidate or candidate in normalized for candidate in candidates):
                return holding
        return {}

    def evidence_sentence(value: object) -> tuple[str, list[str]]:
        facts, sources = supporting_evidence(value)
        evidence_parts: list[str] = []
        markers: list[str] = []
        if facts:
            selected_facts = facts[:2]
            evidence_parts.extend(selected_facts)
            markers.extend(selected_facts)
        if evidence_parts:
            return f"{'；'.join(evidence_parts)}。", markers
        return "", []

    def enrich_analysis(value: object, raw_analysis: object) -> str:
        analysis = str(raw_analysis or "").strip()
        analysis = re.sub(
            r"(?:当日前后可核对的信息|公开报道|数据归因|核验证据|参考来源)\s*[：:]\s*",
            "",
            analysis,
        )
        holding = daily_holding(value)
        daily_return = abs(float(holding.get("dailyReturnPct") or 0))
        relative = abs(float(holding.get("relativePctPoints") or 0))
        percentile = float(holding.get("anomalyPercentile") or 0)
        strong_evidence_mode = daily_return >= 5 or relative >= 3 or percentile >= 85
        sentence, markers = evidence_sentence(value)
        analysis = re.sub(
            r"公开资料抓取不足[^。]*。?",
            sentence,
            analysis,
        )
        has_evidence = any(marker[:16] in analysis for marker in markers if marker)
        if markers and not has_evidence:
            analysis = f"{analysis}{' ' if analysis else ''}{sentence}"
        if strong_evidence_mode and not markers and "未检索到能够直接归因" not in analysis:
            analysis = f"{analysis}{' ' if analysis else ''}目前没有足够的公司特有证据，不据此改变长期判断。"
        if not analysis:
            analysis = sentence or "目前没有足够的新证据改变长期判断。"
        return analysis

    prompt_data = {**context, "publicIntelligence": public_intelligence}
    prompt = f"""
你正在分析日本投资者在 {date_text} 的单日持仓变化。程序已完成所有数字计算；你只能使用输入数字，不得改写金额、收益率或涨跌强度。

目标不是复述面板，而是解释当天变化对持仓判断意味着什么。必须输出简体中文合法 JSON，不要 Markdown。报告必须让用户读完后知道“为什么变、证据是什么、这是否改变长期判断、下一步什么条件会改变决定”，不能用模板化的“受市场影响、持续关注”结束。

规则：
1. summary 用 90～160 字完成“今日总结”：必须包含上涨、下跌、持平数量，组合当日盈亏金额和收益率，主要盈利与亏损来源，商品分类抵消关系，以及长期投资判断是否发生变化。不要逐只罗列全部持仓。
2. changeNature 必须覆盖输入中所有当日盈亏不为 0 的持仓，按绝对盈亏从大到小排列，最多 12 项；禁止固定只返回 3 项。每项 label 要像“财报后预期下修”“个股弱于行业”“汇率放大损失”“主要跟随大盘”。metrics 使用输入中的真实数字，优先展示单日收益率、当日盈亏、今日涨跌强度或期末市值；只有 hasFxExposure=true 时才能展示“汇率影响”。日本股票已经以日元计价，禁止把 USD/JPY 折算影响写成其直接盈亏来源。禁止把 NASDAQ-100、S&P500、TOPIX、基准收益率或相对百分点放入 metrics。
3. analysis 必须按“已知事实→变化传导→长期影响”解释价格变化，不能只写“跑赢/跑输大盘”。程序已经根据资产类型或最近最多60个共同交易日的收益联动性选择 benchmark；必须先用 benchmarkReturnPct 与 relativePctPoints 区分市场共同波动和标的自身变化，再判断行业波动、直接汇率折算、公司特有事件或目前无法确认。benchmarkSelectionReason 说明了基准选择方式，不得自行更换基准。至少给出一个数字、财务事实或明确的“暂未确认公司特有因素”。可以使用 publicIntelligence 中抓取的新闻和财务数据作为内部判断依据，但不得把新闻标题、新闻摘要、来源名称、链接或“公开报道”段落直接展示给用户。若单日绝对涨跌达到 5%、相对基准偏离达到 3 个百分点或涨跌强度达到近60日的 85%，优先结合财报、营收、每股收益、利润率、公司指引、管理层说明和新闻背后的事实判断。
4. 将可核验的财务数字、估值数据、相对表现、汇率影响以及新闻所反映的具体影响融入 analysis 正文，但不要复述新闻内容、标题或来源，不要单独建立“核验证据”“参考来源”“公开报道”段落，不要输出链接。只写“公司指引下修导致市场重新评估盈利预期”这类结论，不要写成新闻摘要；并区分已知事实与推断。财务事件要说明“市场为什么失望或超预期”；如果输入中没有足够证据，直接说明“暂未确认公司特有因素”，不要描述抓取过程或系统能力。
5. logicChanges 只在公开资料或持续相对表现足以影响长期逻辑时输出，最多 3 项。单日涨跌本身不等于逻辑变化。没有有效变化时返回空数组。direction 只能是“增强”“转弱”“失效”。reason 必须基于输入中的财务或公司信息，verification 写下一步用于确认或推翻判断的具体财务指标、公司指引或连续表现条件。
6. actions 输出 1～4 条具体行动条件。可以明确“无需操作”，但必须说明什么财务数据、公司指引或价格/相对表现条件出现后才重新检查、加仓或减仓。禁止泛泛写“注意风险”，禁止输出明日关注内容，禁止擅自修改定投计划。
7. 若没有需要改变持仓判断的新信号，actions 第一条写“今日未发现需要改变持仓判断的新信号。”
8. 不得输出用户已经能直接从面板看到的大段流水，不得提供预测新闻，不得迎合。
9. 只能分析输入 holdings 中列出的当日更新标的，禁止提及或评价任何未出现在 input.holdings 中的其他持仓。

返回格式：
{{"summary":"...","changeNature":[{{"name":"输入中的标的名称","label":"财报后预期下修","metrics":[{{"label":"单日收益率","value":"-2.10%"}},{{"label":"当日盈亏","value":"-12,300日元"}},{{"label":"今日涨跌强度","value":"-88%"}}],"analysis":"公司公布的季度营收和指引……市场下跌主要反映……这是事实/推断……"}}],"logicChanges":[{{"name":"输入中的标的名称","direction":"转弱","reason":"...","verification":"..."}}],"actions":["..."]}}

输入：{json.dumps(prompt_data, ensure_ascii=False, separators=(",", ":"))}
""".strip()
    result, _ = _generate(
        prompt,
        grounded=False,
        schema=DAILY_SUMMARY_SCHEMA,
        timeout=70,
        max_output_tokens=6000,
        attempts=1,
    )
    change_nature = []
    for item in _as_list(result.get("changeNature"))[:12]:
        item = _as_dict(item)
        holding_context = daily_holding(item.get("name"))
        has_fx_exposure = bool(holding_context.get("hasFxExposure"))
        metrics = [
            {"label": str(_as_dict(metric).get("label") or ""), "value": str(_as_dict(metric).get("value") or "")}
            for metric in _as_list(item.get("metrics"))[:5]
            if _as_dict(metric).get("label") and _as_dict(metric).get("value")
            and (has_fx_exposure or "汇率" not in str(_as_dict(metric).get("label") or ""))
            and not re.search(
                r"NASDAQ|纳斯达克|S&P\s*500|TOPIX|基准|相对表现|额外跑赢|额外跑输|百分点",
                f"{_as_dict(metric).get('label') or ''} {_as_dict(metric).get('value') or ''}",
                re.I,
            )
        ]
        if item.get("name") and item.get("analysis") and is_allowed_daily_holding(item.get("name")):
            label = str(item.get("label") or "变化分析")
            if not has_fx_exposure and "汇率" in label:
                benchmark = str(holding_context.get("benchmark") or "")
                relative = holding_context.get("relativePctPoints")
                if benchmark and relative is not None:
                    if float(relative) >= 0.5:
                        label = f"强于{benchmark}"
                    elif float(relative) <= -0.5:
                        label = f"弱于{benchmark}"
                    else:
                        label = "主要跟随市场"
                else:
                    label = "独立价格变化"
            change_nature.append({
                "name": str(item.get("name")),
                "label": label,
                "metrics": metrics,
                "analysis": enrich_analysis(item.get("name"), item.get("analysis")),
            })
    included_names = {
        re.sub(r"[\s　・･（）()&＆._-]+", "", str(item.get("name") or "")).lower()
        for item in change_nature
    }
    for holding in context["holdings"]:
        if len(change_nature) >= 12 or round(float(holding.get("dailyProfitJPY") or 0)) == 0:
            continue
        name = str(holding.get("name") or "")
        symbol = str(holding.get("symbol") or "")
        normalized_name = re.sub(r"[\s　・･（）()&＆._-]+", "", name).lower()
        normalized_symbol = re.sub(r"[\s　・･（）()&＆._-]+", "", symbol).lower()
        if any(
            included == normalized_name
            or (normalized_symbol and (included == normalized_symbol or normalized_symbol in included))
            for included in included_names
        ):
            continue
        profit = round(float(holding.get("dailyProfitJPY") or 0))
        daily_return = float(holding.get("dailyReturnPct") or 0)
        benchmark = str(holding.get("benchmark") or "")
        benchmark_return = holding.get("benchmarkReturnPct")
        relative = holding.get("relativePctPoints")
        fx_impact = round(float(holding.get("dailyFxImpactJPY") or 0))
        percentile = holding.get("anomalyPercentile")
        metrics = [
            {"label": "单日收益率", "value": f"{daily_return:+.2f}%"},
            {"label": "当日盈亏", "value": f"{profit:+,}日元"},
        ]
        if benchmark and benchmark_return is not None and relative is not None:
            if float(relative) >= 0.5:
                label = f"强于{benchmark}"
            elif float(relative) <= -0.5:
                label = f"弱于{benchmark}"
            else:
                label = "主要跟随市场"
            comparison = f"当日相对{benchmark}{'跑赢' if float(relative) >= 0 else '跑输'}{abs(float(relative)):.2f}个百分点。"
            if holding.get("hasFxExposure") and fx_impact:
                metrics.append({"label": "汇率影响", "value": f"{fx_impact:+,}日元"})
        else:
            if holding.get("hasFxExposure") and fx_impact:
                metrics.append({"label": "汇率影响", "value": f"{fx_impact:+,}日元"})
            label = "汇率影响明显" if holding.get("hasFxExposure") and abs(fx_impact) >= max(500, abs(profit) * 0.2) else "独立价格变化"
            comparison = (
                "该资产没有直接可比的大盘基准，需结合自身价格与汇率变化判断。"
                if holding.get("hasFxExposure")
                else "该资产没有可用的同期基准数据，需结合自身价格与市场环境判断。"
            )
        if percentile is not None:
            signed_percentile = int(percentile) if daily_return >= 0 else -int(percentile)
            metrics.append({"label": "今日涨跌强度", "value": f"{signed_percentile:+d}%"})
            direction_text = "上涨" if daily_return >= 0 else "下跌"
            anomaly_text = f"今日{direction_text}幅度超过近60日约{int(percentile)}%的交易日。"
        else:
            metrics.append({"label": "期末市值", "value": f"{round(float(holding.get('closingValueJPY') or 0)):,}日元"})
            anomaly_text = "现有历史样本不足以判断异常分位。"
        evidence_text, evidence_markers = evidence_sentence(name)
        if abs(daily_return) < 5 and evidence_markers:
            evidence_text = ""
        change_nature.append({
            "name": name,
            "label": label,
            "metrics": metrics[:5],
            "analysis": enrich_analysis(
                name,
                f"{comparison}{anomaly_text}{evidence_text}单日变化是否影响长期逻辑，仍需以后续财务数据或公司指引确认。",
            ),
        })
        included_names.add(normalized_name)
    holding_order = {
        re.sub(r"[\s　・･（）()&＆._-]+", "", str(item.get("name") or "")).lower(): index
        for index, item in enumerate(context["holdings"])
    }
    change_nature.sort(key=lambda item: holding_order.get(
        re.sub(r"[\s　・･（）()&＆._-]+", "", str(item.get("name") or "")).lower(),
        len(holding_order),
    ))
    logic_changes = []
    for item in _as_list(result.get("logicChanges"))[:3]:
        item = _as_dict(item)
        direction = str(item.get("direction") or "")
        if (
            item.get("name")
            and item.get("reason")
            and direction in {"增强", "转弱", "失效"}
            and is_allowed_daily_holding(item.get("name"))
        ):
            logic_changes.append({
                "name": str(item.get("name")),
                "direction": direction,
                "reason": str(item.get("reason")),
                "verification": str(item.get("verification") or "继续观察后续基本面与相对表现。"),
            })
    actions = [str(item) for item in _as_list(result.get("actions")) if str(item).strip()][:4]
    if not actions:
        actions = ["今日未发现需要改变持仓判断的新信号。"]
    return {
        "analysisVersion": 7,
        "date": date_text,
        "facts": context,
        "summary": str(result.get("summary") or "当天持仓变化已完成核对，暂未形成足以改变长期判断的新证据。"),
        "changeNature": change_nature,
        "logicChanges": logic_changes,
        "actions": actions,
        "generatedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "model": str(result.pop("_usedModel", _model())),
    }


def _target_event(goal: dict) -> dict:
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    raw_date = str(goal.get("targetDate") or "").strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}", raw_date):
            year, month = (int(value) for value in raw_date.split("-"))
            event_date = today.replace(year=year, month=month, day=monthrange(year, month)[1])
        else:
            event_date = datetime.fromisoformat(raw_date).date()
    except (TypeError, ValueError):
        event_date = today
    horizon_years = max(0, (event_date - today).days / 365.2425)
    return {
        "eventId": f"target_{event_date.isoformat()}",
        "eventName": f"{event_date.year}年资产目标",
        "eventDate": event_date.isoformat(),
        "horizonYears": round(horizon_years, 2),
        "targetAssetsJPY": round(float(goal.get("targetAssets") or 0)),
    }


def _resolve_asset_type_id(asset_class: str, asset_types: list[dict]) -> str:
    direct = next((asset["id"] for asset in asset_types if asset["id"] == asset_class), None)
    if direct:
        return direct
    keywords = {
        "us": ("美股", "美国", "us"),
        "fund": ("基金", "投信", "fund"),
        "jp": ("日股", "日本", "jp"),
        "gold": ("黄金", "gold"),
        "cash": ("现金", "cash"),
    }
    for asset in asset_types:
        key = f"{asset['id']} {asset['name']}".lower()
        if any(word in key for word in keywords.get(asset_class, ())):
            return asset["id"]
    return asset_types[0]["id"] if asset_types else asset_class


def _rate(value: object, fallback: float) -> tuple[float, bool]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback, True
    if not math.isfinite(parsed) or parsed <= -100 or parsed > 200:
        return fallback, True
    return parsed, False


def _value_multiple(value: object, fallback: float) -> tuple[float, bool]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback, True
    if not math.isfinite(parsed) or parsed <= 0.05 or parsed > 20:
        return fallback, True
    return parsed, False


def _multiple_to_cagr(value_multiple: float, horizon_years: float) -> float:
    years = max(1 / 12, float(horizon_years or 0))
    return (math.pow(max(0.0001, value_multiple), 1 / years) - 1) * 100


def _rate_to_multiple(rate_pct: float, horizon_years: float) -> float:
    years = max(1 / 12, float(horizon_years or 0))
    return math.pow(max(0.0001, 1 + float(rate_pct) / 100), years)


FORECAST_SCHEMA = {
    "type": "object",
    "properties": {
        "assetForecasts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "assetTypeId": {"type": "string"},
                    "bearValueMultiple": {"type": "number"},
                    "baseValueMultiple": {"type": "number"},
                    "bullValueMultiple": {"type": "number"},
                    "revenueOutlook": {"type": "string"},
                    "epsOutlook": {"type": "string"},
                    "marginOutlook": {"type": "string"},
                    "valuationOutlook": {"type": "string"},
                    "rationale": {"type": "string"},
                    "returnEngine": {"type": "string"},
                    "catalysts": {"type": "array", "items": {"type": "string"}},
                    "downsideTriggers": {"type": "array", "items": {"type": "string"}},
                    "decisionSignal": {"type": "string"},
                },
                "required": [
                    "assetTypeId",
                    "bearValueMultiple",
                    "baseValueMultiple",
                    "bullValueMultiple",
                    "revenueOutlook",
                    "epsOutlook",
                    "marginOutlook",
                    "valuationOutlook",
                    "rationale",
                ],
            },
        },
    },
    "required": ["assetForecasts"],
}


def forecast_asset_returns(portfolio: dict, goal: dict) -> dict:
    asset_types = [
        {
            "id": str(asset.get("id") or ""),
            "name": str(asset.get("name") or "资产"),
            "amountJPY": round(float(asset.get("amount") or 0)),
            "currentAssumptionPct": round(float(asset.get("annualRate") or 0), 2),
        }
        for asset in goal.get("assetTypes") or []
        if isinstance(asset, dict) and asset.get("id")
    ]
    holdings = _holding_summary(portfolio)
    holding_total = sum(max(0, float(holding.get("valueJPY") or 0)) for holding in holdings)
    represented_asset_types: set[str] = set()
    forecast_targets: list[dict] = []
    for holding in holdings:
        asset_type_id = _resolve_asset_type_id(str(holding.get("assetClass") or "other"), asset_types)
        represented_asset_types.add(asset_type_id)
        forecast_targets.append({
            "holdingId": holding["holdingId"],
            "name": holding["name"],
            "symbol": holding.get("symbol") or "",
            "market": holding.get("market") or "",
            "account": holding.get("account") or "",
            "assetClass": holding.get("assetClass") or "other",
            "category": holding.get("category") or "other",
            "valueJPY": holding.get("valueJPY") or 0,
            "costJPY": holding.get("costJPY") or 0,
            "profitJPY": holding.get("profitJPY") or 0,
            "profitRatePct": holding.get("profitRatePct") or 0,
            "dayChangePct": holding.get("dayChangePct"),
            "latestPrice": holding.get("latestPrice"),
            "currency": holding.get("currency"),
            "assetTypeId": asset_type_id,
            "weightPct": round(float(holding.get("valueJPY") or 0) / holding_total * 100, 2) if holding_total else 0,
            "synthetic": False,
        })
    for asset in asset_types:
        if asset["id"] not in represented_asset_types:
            forecast_targets.append({
                "holdingId": f"asset-type:{asset['id']}",
                "name": asset["name"],
                "symbol": "",
                "market": "",
                "account": "",
                "assetClass": asset["id"],
                "category": "unclassified_public_asset",
                "assetTypeId": asset["id"],
                "valueJPY": asset["amountJPY"],
                "costJPY": 0,
                "profitJPY": 0,
                "profitRatePct": 0,
                "weightPct": round(asset["amountJPY"] / max(1, sum(item["amountJPY"] for item in asset_types)) * 100, 2),
                "synthetic": True,
            })
    event = _target_event(goal)
    previous_forecast_payload = goal.get("previousForecast")
    if not isinstance(previous_forecast_payload, dict):
        previous_forecast_payload = {}
    previous_holding_forecasts = previous_forecast_payload.get("holdingForecasts")
    if not isinstance(previous_holding_forecasts, list):
        previous_holding_forecasts = []
    previous_forecasts = {
        str(item.get("holdingId") or ""): item
        for item in previous_holding_forecasts
        if isinstance(item, dict) and item.get("holdingId")
    }
    for target in forecast_targets:
        previous = previous_forecasts.get(str(target.get("holdingId") or ""))
        if previous:
            target["previousBaseRatePct"] = previous.get("baseRate")
    all_holdings = sorted(
        (item for item in forecast_targets if not item["synthetic"]),
        key=lambda item: float(item["valueJPY"]),
        reverse=True,
    )
    planning_context = goal.get("planningContext") if isinstance(goal.get("planningContext"), dict) else {}
    current_performance = goal.get("currentPerformance") if isinstance(goal.get("currentPerformance"), dict) else {}
    planning_assumptions = planning_context.get("assumptions")
    if not isinstance(planning_assumptions, dict):
        planning_assumptions = {}
    contribution_plans = planning_context.get("contributionPlans")
    if not isinstance(contribution_plans, list):
        contribution_plans = []
    portfolio_fx = portfolio.get("fx")
    if not isinstance(portfolio_fx, dict):
        portfolio_fx = {}
    usd_jpy_quote = portfolio_fx.get("USDJPY")
    if not isinstance(usd_jpy_quote, dict):
        usd_jpy_quote = {}
    public_intelligence = _public_market_intelligence(all_holdings)
    analysis_context = {
        "currentAssetsJPY": round(sum(max(0, float(item.get("valueJPY") or 0)) for item in forecast_targets if not item["synthetic"])),
        "currentPerformance": current_performance,
        "allHoldings": [
            {
                "name": target["name"],
                "symbol": target.get("symbol") or "",
                "assetTypeId": target["assetTypeId"],
                "market": target.get("market") or "",
                "account": target.get("account") or "",
                "valueJPY": target["valueJPY"],
                "costJPY": target.get("costJPY") or 0,
                "profitJPY": target.get("profitJPY") or 0,
                "weightPct": target["weightPct"],
                "profitRatePct": target["profitRatePct"],
                "dayChangePct": target.get("dayChangePct"),
            }
            for target in all_holdings
        ],
        "contributionPlans": contribution_plans,
        "currentWeightedAssumptionPct": planning_assumptions.get("weightedAnnualRatePct"),
        "requiredAnnualRatePct": planning_assumptions.get("requiredAnnualRatePct"),
    }
    prompt_data = {
        "today": datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat(),
        "baseCurrency": "JPY",
        "targetEvent": event,
        "usdJpy": goal.get("currentUsdJpy") or usd_jpy_quote.get("price"),
        "assetTypes": [
            {
                "id": asset["id"],
                "name": asset["name"],
                "amountJPY": asset["amountJPY"],
            }
            for asset in asset_types
        ],
        "allHoldings": [
            {
                "name": target["name"],
                "symbol": target.get("symbol") or "",
                "assetTypeId": target["assetTypeId"],
                "category": target.get("category") or "other",
                "market": target.get("market") or "",
                "account": target.get("account") or "",
                "weightPct": target.get("weightPct") or 0,
                "valueJPY": target.get("valueJPY") or 0,
                "costJPY": target.get("costJPY") or 0,
                "profitJPY": target.get("profitJPY") or 0,
                "profitRatePct": target.get("profitRatePct") or 0,
                "dayChangePct": target.get("dayChangePct"),
                "latestPrice": target.get("latestPrice"),
                "currency": target.get("currency") or "JPY",
            }
            for target in all_holdings
        ],
        "currentPerformance": current_performance,
        "investmentPlan": {
            "contributionPlans": analysis_context["contributionPlans"],
            "requiredAnnualRatePct": analysis_context["requiredAnnualRatePct"],
        },
        "portfolioLastRefreshAt": portfolio.get("lastRefreshAt"),
        "publicMarketIntelligence": public_intelligence,
    }
    information_rule = "必须以 portfolioLastRefreshAt 对应的持仓价格、收益表现和 USD/JPY 为组合分析时点，并以 publicMarketIntelligence 中由软件刚刚抓取的公开新闻、估值和季度财务数据作为最新情报；所有实时结论必须注明数据日期，不得凭记忆虚构。"
    prompt = f"""
你是日本长期投资组合的资产研究与终值估值引擎。{information_rule}
只分析输入 assetTypes 的每种资产类型，研究从今天到 targetEvent 的经营路径与终值。你不能直接拍脑袋填写年化率：必须先预测 Revenue、EPS、Margin 与估值变化，再返回目标时点相对当前价值的 Bear/Base/Bull 倍数。软件将用该倍数计算目标价值与 CAGR，并独立处理 USD/JPY、定投与复利。

要求：
- 所有会展示给用户的字符串必须使用自然、易懂的简体中文。Revenue、EPS、Margin、Forward PE、P/E、CapEx、CAGR、Bear、Base、Bull 等英文财务术语只能用于内部推理，输出内容中必须分别写成营收、每股收益、利润率、预期市盈率、市盈率、资本支出、复合年化收益率、悲观情景、基准情景、乐观情景。其他专业缩写也必须翻译或用一句中文解释，禁止直接丢给用户。
- 先以 currentPerformance、allHoldings 与 investmentPlan 还原本次组合的真实特征，再给预测；allHoldings 包含全部持仓，任何一只都不得忽略或以“每类代表股”替代。
- 必须逐只使用 publicMarketIntelligence 中全部持仓的最新新闻与财务摘要。trailingForwardPeRatio 可作为市场盈利预期的估值代理，但不得伪装成精确分析师一致预期；缺少某项数据时必须基于已有数据降低断言强度，不得编造。
- 最新情报不是背景装饰。每个资产类型的 rationale、returnEngine、catalysts、downsideTriggers 必须吸收其全部底层持仓的新闻、估值与季度经营趋势；重大持仓之间若增长、估值或风险方向不同，必须明确说明其对该资产类型年化的加权影响。
- 每个 assetTypeId 必须返回 Bear/Base/Bull 目标价值倍数；Base 是未来目标期限内最可能的经营与估值路径，不是传统均衡组合的长期均值。必须从实际持仓结构出发：高成长个股、成长指数基金、宽基基金、日股和黄金等资产的回报驱动不同，禁止套用同一个折现模板。
- 历史收益只用于检查结果是否离谱，既不是收益率下限，也不是预测公式。禁止简单套用近5年、10年平均值，禁止固定比例折算、均值回归式打折，禁止根据用户旧设定校准答案。
- 预测核心必须前瞻：逐类判断未来目标期限内的 Revenue、EPS、Margin、估值扩张/收缩、股息回购、产业周期、竞争格局、政策与 USD/JPY 影响，再用这些分项合成 Bear/Base/Bull 目标价值倍数。revenueOutlook、epsOutlook、marginOutlook、valuationOutlook 必须分别写清预测区间与依据；returnEngine 必须说明这些分项如何传导至终值倍数。
- Base 是截至目标日期最可能实现的复合路径，不是保守值。若输入持仓所属产业的盈利兑现仍在加速，必须把未来1～3年的订单、资本支出、产品落地和利润弹性纳入，不得因为波动率高就压低预期；若估值已透支，也必须明确量化估值收缩会抵消多少盈利增长。
- 情景中心必须重新校准：凡是 publicMarketIntelligence 已能支持、且只要求当前产业趋势与经营节奏正常延续的增长，不得放在 Bull，必须计入 Base。Bull 只保留需要盈利显著超预期、产品落地提前、市场份额额外提升或估值扩张等进一步利好才能实现的上行情景。
- Base 不要求位于 Bear 与 Bull 的数学中点。对于盈利仍快速增长、催化剂已有事实支撑的高成长组合，Base 可以明显靠近 Bull；不得为了看起来稳健而把传统宽基指数的保守长期回报套到集中型成长组合上。
- 如果初步判断中的 Bull 主要由“现有 AI CapEx 延续、已公布产品按计划落地、当前利润趋势维持”等非额外惊喜构成，必须把其中的大部分回报上移至 Base，再为 Bull 建立真正高于当前可见趋势的催化路径。
- Bear 必须对应清晰、可观察的不利事件；Base 必须对应最可能的经营路径；Bull 必须对应明确催化剂兑现。三个情景不能只是对同一数字机械加减固定百分点。
- 悲观情景代表不利但仍可执行的多年度路径，不应无理由给出负年化；乐观情景应体现 AI 周期兑现、盈利扩张与估值维持的可能性。
- 黄金按实际利率、央行购金、通胀和美元周期判断，不得固定为 5%。
- 不得虚构实时新闻、修改定投或建议杠杆。只给会改变用户操作、仓位或目标可达性的判断；不要泛泛的市场套话、安慰、重复解释或无行动价值的背景。
- 每类资产必须输出：rationale（100～180字的完整判断）、returnEngine（回报由什么构成）、catalysts（2项兑现条件）、downsideTriggers（2项下修条件）、decisionSignal（现在应维持、观察还是调整，以及触发线）。这些内容必须互不重复。
- report 必须足以支持决策：summary 100～160字；reasons 4项，禁止复述“持仓金额、当前收益率、当前年化”等输入摘要。每项 detail 必须形成完整论证链：未来经营或产业判断 → 回报/风险传导机制 → 对目标实现的具体影响 → 用于证实或推翻判断的指标。growthDrivers、risks、actions 各3项，每项45～90字；必须说明为什么重要，不能只有结论。
- targetProbability 必须由你给出最终判断，软件不会再覆盖。请用 Bear/Base/Bull 终值路径、各情景合理发生权重、目标期限、当前资产、未来定投、集中度和波动性综合估计“目标资产按期实现”的概率；它不是上涨概率。不得沿用输入中旧假设对应的概率，不能因为 Base 低于目标就机械设为 50% 以下，也不能因为 Bull 达标就机械设为高概率，必须与本次三种情景及目标缺口一致。
- sensitivityFactors 必须由你根据本次全部持仓、定投、目标期限、汇率暴露、Bear/Base/Bull差异和前瞻经营判断重新选择，禁止每次机械返回同一组因素。挑出真正最决定目标结果的3～5项，可具体到个股、资产类型、每月投入、USD/JPY或目标期限；importanceScore是相对重要程度评分，rationale用一句话说明它通过什么路径改变目标资产。
- goalLevers 必须由你根据本次目标缺口和敏感因素提出3～5个最有效、可由软件复算的改善动作，必须实际返回至少3项，不能只返回1项，且不能用同一种动作重复凑数。禁止固定套用同一金额或同一资产。type只能为 monthly_extra、asset_monthly_extra、rate_shift、delay_target；涉及定向加仓时 assetTypeId 必须使用输入 assetTypes 中真实存在的id。amountJPY、rateShiftPct、delayMonths只填写该动作实际需要的参数，其他数字填0。动作必须遵守年度预算、禁止杠杆且不擅自修改用户已保存的定投计划；这里只是比较方案，不是自动执行。
- actions 必须与前述论证逐项对应，写清观察指标、触发条件和届时动作，不得只写“长期持有”“注意风险”。conclusion 用80～140字直接说明当前最合理选择及什么时候改变。禁止用任何一段单纯介绍用户目前有什么资产。
- 这是单次请求。字段必须严格按下方格式返回，不得增加其他字段，不得重复句子。所有字符串中不得使用英文双引号。
- 输出必须是合法 JSON，可使用空格但禁止 Markdown、中文引号和尾随逗号。

返回格式：
{{
  "assetForecasts":[{{"assetTypeId":"必须与输入一致","bearValueMultiple":1.15,"baseValueMultiple":2.55,"bullValueMultiple":3.65,"revenueOutlook":"目标期营收增长路径与区间","epsOutlook":"目标期每股收益增长路径与区间","marginOutlook":"目标期利润率变化与区间","valuationOutlook":"目标期估值倍数扩张或收缩路径","rationale":"结合当前持仓、经营增长和估值的完整判断","returnEngine":"营收、每股收益、利润率、估值、股息和汇率如何形成目标价值倍数","catalysts":["催化剂与验证指标一","催化剂与验证指标二"],"downsideTriggers":["下修触发条件一","下修触发条件二"],"decisionSignal":"当前动作与改变判断的条件"}}],
  "report":{{"targetProbability":65,"status":"在轨","summary":"组合目标、当前速度和主要缺口的完整判断","reasons":[{{"title":"关键判断","detail":"组合事实、判断及对目标的影响"}}],"growthDrivers":["增长来源、验证指标及贡献路径"],"risks":["风险、触发条件及组合影响"],"actions":["观察指标、触发条件和具体动作"],"sensitivityFactors":[{{"label":"主要高权重持仓的长期回报","importanceScore":31,"rationale":"主要持仓的经营兑现程度会显著改变组合终值"}},{{"label":"每月投入金额","importanceScore":24,"rationale":"新增本金规模直接改变目标日期前可参与复利的资产基数"}},{{"label":"美元兑日元汇率","importanceScore":12,"rationale":"日元升贬值会改变美元资产折算后的目标终值"}}],"goalLevers":[{{"type":"asset_monthly_extra","label":"在估值回落时增加重点资产投入","assetTypeId":"输入中真实存在的资产类型ID","amountJPY":30000,"rateShiftPct":0,"delayMonths":0,"reason":"针对最敏感且具备长期催化的资产提高投入效率"}},{{"type":"monthly_extra","label":"提高每月总投入","assetTypeId":"","amountJPY":20000,"rateShiftPct":0,"delayMonths":0,"reason":"直接提高进入复利周期的本金"}},{{"type":"delay_target","label":"适当延长目标期限","assetTypeId":"","amountJPY":0,"rateShiftPct":0,"delayMonths":12,"reason":"用更长复利时间降低所需年化"}}],"conclusion":"当前最合理选择以及改变选择的条件"}}
}}

输入：{json.dumps(prompt_data, ensure_ascii=False, separators=(",", ":"))}
""".strip()
    result, sources = _generate(
        prompt,
        grounded=False,
        schema=GOAL_ANALYSIS_SCHEMA,
        timeout=90,
        max_output_tokens=16000,
        attempts=1,
    )
    public_sources: list[dict] = []
    seen_source_urls: set[str] = set()
    for holding_intel in _as_list(_as_dict(public_intelligence).get("holdings")):
        holding_intel = _as_dict(holding_intel)
        for item in _as_list(holding_intel.get("news")):
            item = _as_dict(item)
            url = str(item.get("url") or "")
            if url and url not in seen_source_urls:
                seen_source_urls.add(url)
                public_sources.append({"title": str(item.get("title") or holding_intel.get("name") or "最新新闻"), "url": url})
    for item in _as_list(_as_dict(public_intelligence).get("macroNews")):
        item = _as_dict(item)
        url = str(item.get("url") or "")
        if url and url not in seen_source_urls:
            seen_source_urls.add(url)
            public_sources.append({"title": str(item.get("title") or item.get("topic") or "宏观新闻"), "url": url})
    sources = [*public_sources[:24], *sources]
    used_model = str(result.pop("_usedModel", _model()))
    returned = {
        str(item.get("assetTypeId") or ""): item
        for item in _as_list(result.get("assetForecasts"))
        if isinstance(item, dict)
    }
    holding_forecasts: list[dict] = []
    fallback_by_asset = {asset["id"]: float(asset["currentAssumptionPct"]) for asset in asset_types}
    horizon_years = max(1 / 12, float(event.get("horizonYears") or 0))
    for target in forecast_targets:
        item = _as_dict(returned.get(str(target["assetTypeId"])))
        fallback = fallback_by_asset.get(str(target["assetTypeId"]), 0)
        fallback_multiple = _rate_to_multiple(fallback, horizon_years)
        base_multiple, base_fallback = _value_multiple(item.get("baseValueMultiple"), fallback_multiple)
        bear_multiple, bear_fallback = _value_multiple(
            item.get("bearValueMultiple"),
            _rate_to_multiple(fallback - 8, horizon_years),
        )
        bull_multiple, bull_fallback = _value_multiple(
            item.get("bullValueMultiple"),
            _rate_to_multiple(fallback + 8, horizon_years),
        )
        bear_multiple, base_multiple, bull_multiple = sorted((bear_multiple, base_multiple, bull_multiple))
        bear_rate = _multiple_to_cagr(bear_multiple, horizon_years)
        base_rate = _multiple_to_cagr(base_multiple, horizon_years)
        bull_rate = _multiple_to_cagr(bull_multiple, horizon_years)
        fallback_used = any((base_fallback, bear_fallback, bull_fallback))
        data_quality = str(item.get("dataQuality") or ("low" if fallback_used else "medium")).lower()
        if data_quality not in {"high", "medium", "low"}:
            data_quality = "low"
        confidence = str(item.get("confidence") or ("low" if data_quality == "low" else "medium")).lower()
        if confidence not in {"high", "medium", "low"}:
            confidence = "low"
        previous_base = target.get("previousBaseRatePct")
        holding_forecasts.append({
            "holdingId": target["holdingId"],
            "assetTypeId": target["assetTypeId"],
            "name": target["name"],
            "symbol": target.get("symbol") or "",
            "category": target.get("category") or "other",
            "valueJPY": round(float(target.get("valueJPY") or 0)),
            "weightPct": round(float(target.get("weightPct") or 0), 2),
            "bearRate": round(bear_rate, 2),
            "baseRate": round(base_rate, 2),
            "bullRate": round(bull_rate, 2),
            "bearValueMultiple": round(bear_multiple, 4),
            "baseValueMultiple": round(base_multiple, 4),
            "bullValueMultiple": round(bull_multiple, 4),
            "bearTargetValueJPY": round(float(target.get("valueJPY") or 0) * bear_multiple),
            "baseTargetValueJPY": round(float(target.get("valueJPY") or 0) * base_multiple),
            "bullTargetValueJPY": round(float(target.get("valueJPY") or 0) * bull_multiple),
            "confidence": confidence,
            "dataQuality": data_quality,
            "revenueOutlook": str(item.get("revenueOutlook") or ""),
            "epsOutlook": str(item.get("epsOutlook") or ""),
            "marginOutlook": str(item.get("marginOutlook") or ""),
            "valuationOutlook": str(item.get("valuationOutlook") or ""),
            "growthAssumption": str(item.get("growthAssumption") or ""),
            "valuationAssumption": str(item.get("valuationAssumption") or ""),
            "marginAssumption": str(item.get("marginAssumption") or ""),
            "rationale": str(item.get("rationale") or "模型未提供足够的前瞻判断依据。"),
            "drivers": [str(value) for value in item.get("drivers") or []][:4],
            "risks": [str(value) for value in item.get("risks") or []][:4],
            "largestUncertainty": str(item.get("largestUncertainty") or "缺少足够的最新基本面与估值数据"),
            "previousBaseRate": previous_base,
            "changePctPoints": round(base_rate - float(previous_base), 2) if previous_base is not None else None,
            "changeReason": str(item.get("changeReason") or ""),
        })

    forecasts: list[dict] = []
    for asset in asset_types:
        members = [item for item in holding_forecasts if item["assetTypeId"] == asset["id"]]
        member_total = sum(max(0, float(item["valueJPY"])) for item in members)
        if member_total:
            weighted = lambda key: sum(float(item["valueJPY"]) * float(item[key]) for item in members) / member_total
            bear_multiple = weighted("bearValueMultiple")
            base_multiple = weighted("baseValueMultiple")
            bull_multiple = weighted("bullValueMultiple")
        elif members:
            bear_multiple = sum(float(item["bearValueMultiple"]) for item in members) / len(members)
            base_multiple = sum(float(item["baseValueMultiple"]) for item in members) / len(members)
            bull_multiple = sum(float(item["bullValueMultiple"]) for item in members) / len(members)
        else:
            base_rate = float(asset["currentAssumptionPct"])
            bear_rate, bull_rate = base_rate - 8, base_rate + 8
            bear_multiple = _rate_to_multiple(bear_rate, horizon_years)
            base_multiple = _rate_to_multiple(base_rate, horizon_years)
            bull_multiple = _rate_to_multiple(bull_rate, horizon_years)
        bear_multiple, base_multiple, bull_multiple = sorted((bear_multiple, base_multiple, bull_multiple))
        bear_rate = _multiple_to_cagr(bear_multiple, horizon_years)
        base_rate = _multiple_to_cagr(base_multiple, horizon_years)
        bull_rate = _multiple_to_cagr(bull_multiple, horizon_years)
        main_members = sorted(members, key=lambda item: float(item["valueJPY"]), reverse=True)[:3]
        source_item = _as_dict(returned.get(asset["id"]))
        rationale_parts = [str(source_item.get("rationale") or "")]
        return_engine = str(source_item.get("returnEngine") or "")
        decision_signal = str(source_item.get("decisionSignal") or "")
        catalysts = [str(value) for value in source_item.get("catalysts") or []][:2]
        downside_triggers = [str(value) for value in source_item.get("downsideTriggers") or []][:2]
        forecasts.append({
            "assetTypeId": asset["id"],
            "assetName": asset["name"],
            "bearRate": round(bear_rate, 2),
            "annualRate": round(base_rate, 2),
            "baseRate": round(base_rate, 2),
            "bullRate": round(bull_rate, 2),
            "bearValueMultiple": round(bear_multiple, 4),
            "baseValueMultiple": round(base_multiple, 4),
            "bullValueMultiple": round(bull_multiple, 4),
            "bearTargetValueJPY": round(float(asset["amountJPY"]) * bear_multiple),
            "baseTargetValueJPY": round(float(asset["amountJPY"]) * base_multiple),
            "bullTargetValueJPY": round(float(asset["amountJPY"]) * bull_multiple),
            "revenueOutlook": str(source_item.get("revenueOutlook") or ""),
            "epsOutlook": str(source_item.get("epsOutlook") or ""),
            "marginOutlook": str(source_item.get("marginOutlook") or ""),
            "valuationOutlook": str(source_item.get("valuationOutlook") or ""),
            "rationale": "；".join(part for part in rationale_parts if part),
            "returnEngine": return_engine,
            "catalysts": catalysts,
            "downsideTriggers": downside_triggers,
            "decisionSignal": decision_signal,
            "drivers": list(dict.fromkeys(value for item in main_members for value in item["drivers"]))[:4],
            "risks": list(dict.fromkeys(value for item in main_members for value in item["risks"]))[:4],
            "holdingCount": len(members),
        })
    portfolio_total = sum(max(0, float(asset["amountJPY"])) for asset in asset_types)
    portfolio_rates = {}
    for key in ("bearRate", "baseRate", "bullRate"):
        portfolio_rates[key] = round(
            sum(float(asset["amountJPY"]) * float(next(item[key if key != "baseRate" else "annualRate"] for item in forecasts if item["assetTypeId"] == asset["id"])) for asset in asset_types) / portfolio_total,
            2,
        ) if portfolio_total else 0
    return {
        "generatedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "model": used_model,
        "targetEvent": event,
        "marketSummary": str(result.get("marketSummary") or ""),
        "portfolioSummary": str(result.get("portfolioSummary") or ""),
        "keyAssumptions": [str(value) for value in result.get("keyAssumptions") or []][:6],
        "assetForecasts": forecasts,
        "holdingForecasts": holding_forecasts,
        "portfolioForecast": portfolio_rates,
        "portfolioStyle": str(result.get("portfolioStyle") or ""),
        "mainReturnEngine": str(result.get("mainReturnEngine") or ""),
        "mainRisk": str(result.get("mainRisk") or ""),
        "historicalVsForward": str(result.get("historicalVsForward") or ""),
        "sources": sources,
        "analysisContext": analysis_context,
        "report": _normalize_report(result.get("report"), used_model),
    }


REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "targetProbability": {"type": "integer", "minimum": 1, "maximum": 99},
        "status": {"type": "string", "enum": ["在轨", "接近目标", "需要提高", "目标激进"]},
        "summary": {"type": "string"},
        "reasons": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "detail": {"type": "string"}},
                "required": ["title", "detail"],
            },
            "minItems": 2,
            "maxItems": 5,
        },
        "growthDrivers": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
        "risks": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
        "actions": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
        "sensitivityFactors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "importanceScore": {"type": "number"},
                    "rationale": {"type": "string"},
                },
                "required": ["label", "importanceScore", "rationale"],
            },
            "minItems": 3,
            "maxItems": 5,
        },
        "goalLevers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["monthly_extra", "asset_monthly_extra", "rate_shift", "delay_target"]},
                    "label": {"type": "string"},
                    "assetTypeId": {"type": "string"},
                    "amountJPY": {"type": "number"},
                    "rateShiftPct": {"type": "number"},
                    "delayMonths": {"type": "integer"},
                    "reason": {"type": "string"},
                },
                "required": ["type", "label", "assetTypeId", "amountJPY", "rateShiftPct", "delayMonths", "reason"],
            },
            "minItems": 3,
            "maxItems": 5,
        },
        "conclusion": {"type": "string"},
    },
    "required": ["targetProbability", "status", "summary", "reasons", "growthDrivers", "risks", "actions", "sensitivityFactors", "goalLevers", "conclusion"],
}


GOAL_ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        **FORECAST_SCHEMA["properties"],
        "report": REPORT_SCHEMA,
    },
    "required": [*FORECAST_SCHEMA["required"], "report"],
}


def _normalize_report(value: object, model: str | None = None) -> dict:
    report = value if isinstance(value, dict) else {}
    try:
        target_probability = int(report.get("targetProbability") or 1)
    except (TypeError, ValueError):
        target_probability = 1
    status = str(report.get("status") or "需要提高")
    if status not in {"在轨", "接近目标", "需要提高", "目标激进"}:
        status = "需要提高"
    reasons = [item for item in report.get("reasons") or [] if isinstance(item, dict)]
    sensitivity_factors = [item for item in report.get("sensitivityFactors") or [] if isinstance(item, dict)]
    allowed_lever_types = {"monthly_extra", "asset_monthly_extra", "rate_shift", "delay_target"}
    goal_levers = [
        item for item in report.get("goalLevers") or []
        if isinstance(item, dict) and str(item.get("type") or "") in allowed_lever_types
    ]
    return {
        "targetProbability": min(99, max(1, target_probability)),
        "status": status,
        "summary": str(report.get("summary") or ""),
        "reasons": [
            {"title": str(item.get("title") or ""), "detail": str(item.get("detail") or "")}
            for item in reasons[:5]
        ],
        "growthDrivers": [str(item) for item in report.get("growthDrivers") or []][:5],
        "risks": [str(item) for item in report.get("risks") or []][:5],
        "actions": [str(item) for item in report.get("actions") or []][:5],
        "sensitivityFactors": [
            {
                "label": str(item.get("label") or "关键因素"),
                "importanceScore": max(0.1, min(100, float(item.get("importanceScore") or 0.1))),
                "rationale": str(item.get("rationale") or ""),
            }
            for item in sensitivity_factors[:5]
        ],
        "goalLevers": [
            {
                "type": str(item.get("type") or ""),
                "label": str(item.get("label") or "改善方案"),
                "assetTypeId": str(item.get("assetTypeId") or ""),
                "amountJPY": max(0, round(float(item.get("amountJPY") or 0))),
                "rateShiftPct": max(0, min(30, float(item.get("rateShiftPct") or 0))),
                "delayMonths": max(0, min(120, int(item.get("delayMonths") or 0))),
                "reason": str(item.get("reason") or ""),
            }
            for item in goal_levers[:5]
        ],
        "conclusion": str(report.get("conclusion") or ""),
        "generatedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "model": model or _model(),
    }


def build_blueprint_report(portfolio: dict, forecast: dict, blueprint: dict) -> dict:
    compact_forecast = {
        "targetEvent": forecast.get("targetEvent"),
        "marketSummary": forecast.get("marketSummary"),
        "portfolioSummary": forecast.get("portfolioSummary"),
        "keyAssumptions": forecast.get("keyAssumptions"),
        "assetForecasts": forecast.get("assetForecasts"),
        "portfolioForecast": forecast.get("portfolioForecast"),
        "portfolioStyle": forecast.get("portfolioStyle"),
        "mainReturnEngine": forecast.get("mainReturnEngine"),
        "mainRisk": forecast.get("mainRisk"),
        "historicalVsForward": forecast.get("historicalVsForward"),
        "holdingForecasts": [
            {
                "holdingId": item.get("holdingId"),
                "name": item.get("name"),
                "symbol": item.get("symbol"),
                "weightPct": item.get("weightPct"),
                "bearRate": item.get("bearRate"),
                "baseRate": item.get("baseRate"),
                "bullRate": item.get("bullRate"),
                "rationale": item.get("rationale"),
                "drivers": item.get("drivers"),
                "risks": item.get("risks"),
                "largestUncertainty": item.get("largestUncertainty"),
            }
            for item in forecast.get("holdingForecasts") or []
            if isinstance(item, dict)
        ],
    }
    prompt_data = {
        "portfolio": {
            "holdings": _holding_summary(portfolio),
            "lastRefreshAt": portfolio.get("lastRefreshAt"),
        },
        "aiForecast": compact_forecast,
        "calculatedBlueprint": blueprint,
    }
    prompt = f"""
你是日本长期投资者的目标规划分析员。软件已经根据当前持仓、用户自己填写的定投计划和前瞻年化假设完成确定性计算。请解释结果，不要重新计算或修改定投。所有展示给用户的文字必须使用自然、易懂的简体中文；任何英文财务术语或缩写都必须翻译成中文或紧接一句中文解释。

请给出一个“目标实现概率”。这是基于悲观/基准/乐观结果、目标年限、所需年化、当前组合集中度和定投持续性的估算，不得伪装成统计保证。概率必须在 1 到 99 之间。

要求：
- 明确目标是否在轨、主要增长来源、关键风险和可执行的观察重点。
- sensitivityFactors 根据全部持仓、定投、目标期限、汇率暴露和三种情景重新选择真正决定目标结果的3～5项，不得固定套用同一组因素。
- goalLevers 根据本次目标缺口提出3～5个最有效的可复算方案，必须实际返回至少3项且动作类型不能全部相同；type只能为 monthly_extra、asset_monthly_extra、rate_shift、delay_target，定向投入必须填写真实 assetTypeId，未使用的数字参数填0。
- 不要输出置信度。
- 不要建议融资、杠杆或借钱投资。
- actions 应侧重纪律、定投持续性、再平衡观察条件，不得擅自改变用户填写的定投金额。
- 所有金额和日期以 calculatedBlueprint 为准。
- 这是预测，不是事实。

输入数据：
{json.dumps(prompt_data, ensure_ascii=False, separators=(",", ":"))}
""".strip()
    result, _ = _generate(
        prompt,
        grounded=False,
        schema=REPORT_SCHEMA,
        timeout=52,
        max_output_tokens=4096,
        attempts=2,
    )
    used_model = str(result.pop("_usedModel", _model()))
    result["targetProbability"] = min(99, max(1, int(result.get("targetProbability") or 1)))
    result["generatedAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
    result["model"] = used_model
    return result
