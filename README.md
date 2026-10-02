# 本地持仓仪表盘

首次使用先安装实时行情组件：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python3 app.py
```

固定云端网址：`https://portfolio-dashboard-delta-eight.vercel.app/`。输入个人密钥后读取对应的云端持仓；电脑关机后仍可访问。桌面的“启动持仓看板”只负责打开固定网址，不再启动本地服务或临时通道。

Yahoo Finance 的公开行情使用行情流和两个可切换的轮询端点，连接中断或单个端点失败时会自动保留上一次成功报价。黄金不再使用黄金期货 `GC=F` 作为现价。基金按每日公布的基准净值更新，本身不具备盘中实时价格。后台每天自动补齐一次收益历史。

“今日盈亏”会同时计算标的价格与 USD/JPY 的当日变化；基金按最新公布净值计算。持仓数量、买入成本和交易流水继续作为市值、累计盈亏与收益率的计算基础。
