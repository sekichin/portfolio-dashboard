#!/usr/bin/env python3

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import cloud_store


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def main() -> None:
    if not cloud_store.enabled():
        raise SystemExit("请先设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY")
    sources = {
        "owner": (ROOT / "data" / "portfolio.json", ROOT / "data" / "goal-simulator.json"),
        "friend": (ROOT / "data" / "friend-portfolio.json", ROOT / "data" / "friend-goal-simulator.json"),
    }
    for profile_id, (portfolio_path, goal_path) in sources.items():
        portfolio = read_json(portfolio_path)
        if portfolio:
            saved = cloud_store.write_portfolio(profile_id, portfolio)
            print(f"{profile_id}: {len(saved.get('holdings', []))} 条持仓，{len(saved.get('history', []))} 天历史")
        settings = read_json(goal_path)
        if settings:
            cloud_store.write_goal_settings(profile_id, settings)
            print(f"{profile_id}: 目标预测设置已迁移")


if __name__ == "__main__":
    main()
