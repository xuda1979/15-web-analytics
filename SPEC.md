# 15 — Web-Analytics: 国内合规去 Cookie 网站分析

## 定位
Plausible / Fathom（隐私分析细分）的国内合规版：去 Cookie、无追踪 ID，
符合国内个人信息保护要求（去标识化/本地可自主定义审计）。母市场：隐私分析细分
千万至亿级；本切片面向国内站长/企业官网。

## 主要痛点
- Google Analytics 在国内不可用/合规风险
- Cookie + user ID 追踪需要弹窗同意，麻烦
- 需要简单、隐私友好（无指纹）的访问数据

## 功能需求
1. 追踪核心（无 Cookie）：
   - 轻量 JS snippet（~1KB）：collect views（url/referrer/ua/screen）
   - 去标识化：不存 IP 完整值（保留 region 级仅好奇？不存 IP：更安全——可选存 hash）
   - 不含个人信息字段（无 name/email）
2. 指标：
   - 页面量 / 独立访客（无 cookie 用 heuristic：IP-hash + ua + 会话时间窗口）
   - 来源（referrer domain）、设备/浏览器（ua 解析本地）
   - 访问路径（页面流、热门页）—入口/出口
3. 仪表板：
   - 实时（web socket 可选）与日/周/月视图
   - 过滤：页面/来源/设备/日期范围
4. 合规：导出审计报告（数据流图）+ 完全本地存储（私有部署）
5. 自托管：单一二进制/容器

## 非目标
- 电商 funnel/用户行为重演（v2 可选）
- 广告归因

## 技术栈
- Node v22（server + 前端）或 Python FastAPI + 前端
- 存储：SQLite（主表 + 聚合缓存表）
- ua 解析：ua-parser-js / python-user-agents
- 部署：Docker / 单二进制（bun 或 pkg 可选）

## 低算力守则
见全局（中间轻量：批量 + SQLite 聚合杯是本地重活）。

## AC
1. snippet 加载后，访问计数出现在实时视图（<1s 延迟）
2. 去 Cookie：页面无 set-cookie（断言在 fixture 部署上）
3. 独立访客 heuristic 工作（模拟 2 用户多页面）
4. 聚合视图（日/周）计算正确（对 fixture 数据验证）
5. 报表导出 CSV/JSON
6. 审计报告可生成（数据流说明）
7. 测试（含 privacy fixture 断言）+ README

## Phases
- P0: collect + SQLite + 计数核心
- P1: 聚合 + 仪表板 UI
- P2: 过滤/导出/实时
- P3: 合规文档

## 里程碑
M1: collect + 聚合（MVP）
M2: 仪表板 + 过滤
M3: 合规 + 导出

## 变现
- 开源 self-host 免费，托管版订阅
