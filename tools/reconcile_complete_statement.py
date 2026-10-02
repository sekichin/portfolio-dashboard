import copy
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "portfolio.json"
OUTPUT = Path("/tmp/reconciled-portfolio.json")


def transaction_template(
    transaction_id,
    name,
    symbol,
    transaction_type,
    price,
    quantity,
    amount_jpy,
    exchange_rate,
    timestamp,
    fee=0,
):
    return {
        "id": transaction_id,
        "holdingId": "",
        "name": name,
        "symbol": symbol,
        "market": "US",
        "account": "特定",
        "product": "美股",
        "type": transaction_type,
        "price": price,
        "quantity": quantity,
        "fee": fee,
        "currency": "USD",
        "exchangeRate": exchange_rate,
        "unitScale": 1,
        "amountJPY": amount_jpy,
        "externalCashFlowJPY": amount_jpy if transaction_type == "BUY" else -amount_jpy,
        "averageCostBeforeJPY": 0,
        "averageCostAfterJPY": 0,
        "realizedProfitJPY": 0,
        "timestamp": f"{timestamp}T12:00:00+09:00",
        "fundId": None,
        "quoteSource": None,
        "annualizedOnly": False,
    }


def recalculate_average_costs(transactions, symbol):
    matching = sorted(
        (item for item in transactions if item.get("symbol") == symbol),
        key=lambda item: (item.get("timestamp", ""), item.get("id", "")),
    )
    units = 0.0
    cost = 0.0
    for item in matching:
        average_before = cost / units if units else 0.0
        item["averageCostBeforeJPY"] = average_before
        quantity = float(item["quantity"])
        if item["type"] == "BUY":
            units += quantity
            cost += float(item["amountJPY"]) + float(item.get("fee") or 0)
            item["realizedProfitJPY"] = 0
        else:
            item["realizedProfitJPY"] = float(item["amountJPY"]) - average_before * quantity - float(item.get("fee") or 0)
            units -= quantity
            cost = max(0.0, average_before * units)
        item["averageCostAfterJPY"] = cost / units if units else 0.0
    return cost / units if units else 0.0


def realized_record(record_id, transaction_id, date, name, proceeds, profit, note, kind="SELL", account="特定", product="美股"):
    return {
        "id": record_id,
        "transactionId": transaction_id,
        "date": date,
        "name": name,
        "proceedsJPY": proceeds,
        "realizedProfitJPY": profit,
        "note": note,
        "kind": kind,
        "account": account,
        "product": product,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


data = json.loads(SOURCE.read_text(encoding="utf-8"))
result = copy.deepcopy(data)
transactions = result["transactions"]
by_id = {item["id"]: item for item in transactions}

by_id["83dQVupd4-_qHDOM"].update({
    "price": 357.445,
    "exchangeRate": 160.11,
    "amountJPY": 114461,
    "externalCashFlowJPY": 114461,
    "timestamp": "2026-04-07T12:00:00+09:00",
    "annualizedOnly": False,
})
by_id["yiHXKsEgzMk9Gy19"].update({
    "price": 233.945,
    "exchangeRate": 162.68,
    "amountJPY": 76492,
    "externalCashFlowJPY": 76492,
    "timestamp": "2026-07-08T12:00:00+09:00",
    "annualizedOnly": False,
})
by_id["adbe-recent-buy-20260728"].update({
    "price": 251.53,
    "exchangeRate": 156.63,
    "amountJPY": 118774,
    "externalCashFlowJPY": 118774,
    "timestamp": "2026-05-07T12:00:00+09:00",
    "annualizedOnly": False,
})
by_id["J1k9RwFR9tsnliPz"].update({
    "fee": 663,
    "externalCashFlowJPY": -122042,
})
for transaction in transactions:
    if transaction.get("name") == "交易税费":
        transaction["account"] = "特定"
        transaction["product"] = "美股"

remove_ids = {
    "MNyti6f4boUySLuk",
    "aapl-sell-20260407",
    "aapl-sell-20260424",
    "aapl-sell-20260507",
    "figma-buy-20260424",
    "figma-sell-20260708",
}
transactions = [item for item in transactions if item["id"] not in remove_ids]
transactions.extend([
    transaction_template("aapl-sell-20260407", "AAPL", "AAPL", "SELL", 260.95, 3, 124329, 159.61, "2026-04-07", 6087),
    transaction_template("aapl-sell-20260424", "AAPL", "AAPL", "SELL", 273.32, 2, 86751, 159.49, "2026-04-24", 4843),
    transaction_template("aapl-sell-20260507", "AAPL", "AAPL", "SELL", 286.66, 3, 133603, 156.13, "2026-05-07", 7971),
    transaction_template("figma-buy-20260424", "Figma", "FIG", "BUY", 17.27, 30, 83300, 159.99, "2026-04-24"),
    transaction_template("figma-sell-20260708", "Figma", "FIG", "SELL", 22.08, 30, 106894, 162.18, "2026-07-08", 4790),
])

for symbol in ("TSLA", "MRVL", "ADBE", "AAPL", "FIG"):
    average_cost = recalculate_average_costs(transactions, symbol)
    holding = next((item for item in result["holdings"] if item.get("symbol") == symbol), None)
    if holding and average_cost:
        holding["buyPrice"] = average_cost

transactions.sort(key=lambda item: (item.get("timestamp", ""), item.get("id", "")))
result["transactions"] = transactions

replace_realized_ids = {
    "3ae314a4-2c9d-4e9b-896a-11792d7588c5",
    "e4ffc1c1-e397-4a64-9cc0-cc6bffdc9972",
    "e6442138-e7ef-4398-92ce-43ca208e972c",
    "aapl-realized-20260407",
    "aapl-realized-20260424",
    "aapl-realized-20260507",
    "adbe-realized-20260729",
    "figma-realized-20260708",
    "dividend-aapl-20250818",
    "dividend-aapl-20251117",
    "dividend-aapl-20260217",
    "dividend-mrvl-20260803",
    "dividend-nok-20260813",
}
realized = [item for item in result.get("realizedTrades", []) if item.get("id") not in replace_realized_ids]
sale_transactions = {item["id"]: item for item in transactions if item["type"] == "SELL"}
realized.extend([
    realized_record("aapl-realized-20260407", "aapl-sell-20260407", "2026-04-07", "AAPL", 124329, sale_transactions["aapl-sell-20260407"]["realizedProfitJPY"], "完整美元流水；已扣税费6,087日元"),
    realized_record("aapl-realized-20260424", "aapl-sell-20260424", "2026-04-24", "AAPL", 86751, sale_transactions["aapl-sell-20260424"]["realizedProfitJPY"], "完整美元流水；已扣税费4,843日元"),
    realized_record("aapl-realized-20260507", "aapl-sell-20260507", "2026-05-07", "AAPL", 133603, sale_transactions["aapl-sell-20260507"]["realizedProfitJPY"], "完整美元流水；已扣税费7,971日元"),
    realized_record("adbe-realized-20260729", "J1k9RwFR9tsnliPz", "2026-07-29", "ADBE", 122042, sale_transactions["J1k9RwFR9tsnliPz"]["realizedProfitJPY"], "完整流水；已扣税费663日元"),
    realized_record("figma-realized-20260708", "figma-sell-20260708", "2026-07-08", "Figma", 106894, sale_transactions["figma-sell-20260708"]["realizedProfitJPY"], "完整美元流水；已扣税费4,790日元"),
    realized_record("dividend-aapl-20250818", "", "2025-08-18", "AAPL 分红", 222, 222, "税后到账", "DIVIDEND"),
    realized_record("dividend-aapl-20251117", "", "2025-11-17", "AAPL 分红", 231, 231, "税后到账", "DIVIDEND"),
    realized_record("dividend-aapl-20260217", "", "2026-02-17", "AAPL 分红", 229, 229, "税后到账", "DIVIDEND"),
    realized_record("dividend-mrvl-20260803", "", "2026-08-03", "MRVL 分红", 65, 65, "税后到账", "DIVIDEND"),
    realized_record("dividend-nok-20260813", "", "2026-08-13", "NOK 分红", 74, 74, "税后到账", "DIVIDEND"),
])
result["realizedTrades"] = sorted(realized, key=lambda item: (item.get("date", ""), item.get("id", "")))

OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({
    "output": str(OUTPUT),
    "transactions": len(result["transactions"]),
    "realizedTrades": len(result["realizedTrades"]),
    "tslaAverageCostJPY": next(item["buyPrice"] for item in result["holdings"] if item.get("symbol") == "TSLA"),
    "mrvlAverageCostJPY": next(item["buyPrice"] for item in result["holdings"] if item.get("symbol") == "MRVL"),
}, ensure_ascii=False, indent=2))
