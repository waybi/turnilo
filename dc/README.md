# 两店 Turnilo 数据同步

入口：<http://127.0.0.1:9092>。数据源是本机 data-center MySQL，范围固定为大兵1号店 uid/cid=113、大兵2号店112，所有历史日期。只读源库，不调用 Noon 写接口。

## 更新与启动

从 Turnilo 根目录执行（不是 svc_base）：

```sh
node --test dc/sync-helpers.test.mjs
node --max-old-space-size=4096 dc/sync-all.mjs
# 停止既有9092进程后启动，不开第二个端口：
node dc/start.mjs
# 另一个终端验证实时服务：
node dc/verify-live.mjs
node dc/verify-recent-orders.mjs 2026-09-25 2026-10-01
```

[sync-all.mjs](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs>) 每次写入新版本，查询计数和导出在同一只读可重复读事务内；每表最长180秒。整批完成才更新 [latest-run.json](</Users/waybi/Desktop/my/turnilo/dc/data/latest-run.json>)。配置和数据路径可从该指针读取；启动器固定只监听本机127.0.0.1:9092。导出不自动终止其他服务，不注册自动刷新/开机任务。

[export.mjs](</Users/waybi/Desktop/my/turnilo/dc/export.mjs>) 是内部核心导出，不再直接写旧数据；保留原有四个分析视图配置，再增加结算、库存、采购、促销、竞品及同步运行记录等视图。当前 1 个总览 + 19 个子视图，两个大搜索词视图按店拆分。

[build-overview.mjs](</Users/waybi/Desktop/my/turnilo/dc/build-overview.mjs>) 把 18 个数据集（含广告商品关联，不含两个搜索词全部窗口和广告搜索词层）加 4 个复盘数据集拼成一张「总览（跨视图）」表，`dataset` 维度就是子视图名；每组指标只对自己的数据集生效，不同数据集金额不要相加。sync-all 每次导出都会自动生成；对已有版本单独补总览用 `node --max-old-space-size=4096 dc/build-overview.mjs`（会写 `config.<run>-overview.yaml` 并更新指针，不重导 MySQL）。

[start.mjs](</Users/waybi/Desktop/my/turnilo/dc/start.mjs>) 将Node堆上限设为6144MB；全部窗口加载曾在4096MB失败，6144MB成功。实际驻留内存依机器及查询变化；这不是6GB预分配。公共市场爬虫的数千万行不能直接塞进该本地文件模式。

## 口径与边界

- 订单按 item_nr 商品条目数；退货率 CIR/(Delivered+CIR)。所有库日期按原文字面日编码到UTC坐标，不做时区换算；用ETC/UTC读图，勿当成数据库时间真实UTC转换结果。
- 广告分析的日报/搜索词/商品指标分层，不跨层相加。搜索词挑各店最新不重叠的完整区间；无法填补区间之间源库没有的缺口，也不能精确按月摊分。
- “搜索词全部窗口”保存两店所有原始行，包含重叠区间；**先选一个报表期**再看花费、订单，默认只展示记录数。默认筛选会按报表开始日期选择，不能当日事实。
- 当前库存、价格、竞品销量、预算、促销是快照；库存/累计销量不可跨多个时点相加，相关指标用平均值或明确日期。采购批次与采购商品是父子两层，不可相加。
- 凭据、客户个人资料、权限配置和备份表不导出。无店铺归属的公共市场表不混入两店事实。catalog_stocks/catalog_fbp_stocks没有店铺字段且PSKU可跨店复用，不能据此断言历史归属；库存以明确cid的skus/sku_catalog_metrics为准。
- 没有两店记录的业务表列入manifest.emptyTables；将来出现数据会让导出停止，要求加明确、安全的字段映射，避免静默漏表。
- 每个版本的manifest保存SQL、来源计数、店铺计数、日期范围、金额摘要及SHA256；没有密码/cookie。文件目录权限0700、数据0600，已从git排除。
- 每张表有独立一致性快照，整批不是跨全部表的同一时刻；常驻同步会继续写入新数据，BI代表manifest.startedAt～completedAt这次导出的快照，不是实时镜像。未启用定时刷新。

## 复盘层并入总览（前台只有 overview 一个入口）

规则（用户 2026-10-02 定）：前台统一用「总览（跨视图）」，不为报告/专题新增 cube；缺维度或指标就在总览里补。两店增长与破冰复盘的证据已按此并入：

- [overview-derived.mjs](</Users/waybi/Desktop/my/turnilo/dc/overview-derived.mjs>) 从本版本的 orders / ad_daily / inventory 文件算出 4 个复盘数据集：「复盘·商品月度增减」（相邻两月每个商品的有效销售额变化，分老品/首次观察成交/恢复成交/本月无成交，老品再拆销量效应与均价效应）、「复盘·破冰节点」（最早订单、最早有效首件、累计 10/50/100 件、首次 7 天里 5/7 天有成交）、「复盘·起步28天」与「复盘·起步28天商品」（从最早有效首件起的完整 28 天段）。纯算术拆分，不是因果归因；经营截止 = 导出当月 1 日（只保留完整月）。
- [build-overview.mjs](</Users/waybi/Desktop/my/turnilo/dc/build-overview.mjs>) 把这 4 个数据集与「广告商品关联（当前）」一并写进 overview.json，并新增维度（商品标题、对比期间、事件/节点、首次观察有效成交日）和指标（有效销售额/条目/均价、出单商品数、有成交天数、归因额/有效销售额、复盘增减 w_*、破冰起步 l_*/lp_*、快照库存价格 min/max、当前商品数）。指标对象自带 `description`，悬停即见。文本字段缺失一律写 `null`（空串会被 Plywood 判成 NUMBER）。
- 对已有版本重算总览：`node --max-old-space-size=4096 dc/build-overview.mjs --rebuild`，写新文件 `overview.<时间戳>.json` 与新配置并更新指针，旧 overview 文件和旧配置保留；manifest 里被替换的 overview 统计移入 `supersededDatasets`。常规 `sync-all.mjs` 导出时自动包含复盘层。
- 报告预设链接：[growth-evidence/config.mjs](</Users/waybi/Desktop/my/turnilo/dc/growth-evidence/config.mjs>) 用 Turnilo 原生 `/mkurl` 编码生成 54 个指向 `#overview/...` 的链接（含“9月 vs 8月”“最近28天 vs 前28天”等原生上一期对比），`node dc/start.mjs` 启动时自动重新生成到 `dc/data/growth-evidence/overview-presets/views.json`；[link-report.py](</Users/waybi/Desktop/my/turnilo/dc/growth-evidence/link-report.py>) 把知识库报告、证据摘要和[导航](</Users/waybi/Desktop/my/knowledge-system/noon/store-growth-2026-10-02/Turnilo证据导航.md>)的证据链接改指这些预设。
- 验收：`node dc/growth-evidence/verify.mjs` 对每个预设核对 `/mkurl` hash、总计与每个叶子分组的指标（离线按同一份 overview 文件重算）、13 个报告关键数字，并与知识库冻结 CSV（bridges / milestones / launch_blocks）逐项比对；`node dc/verify-live.mjs` 独立验证 20 个 cube。
- 已撤下：独立 `growth_evidence_202609` cube 及 `config.growth-evidence.yaml`；`dc/data/growth-evidence/202609-v*/` 是迁移前的冻结文件，留作审计，不再加载。

## 指标说明（鼠标悬停）

每个指标都有一段大白话说明：在表格（Table）视图里，鼠标停在指标列的表头（如“记录数”“订单 · 商品条目”）约 0.25 秒，表头下方弹出“是什么 / 怎么算 / 注意”；左侧 MEASURES 列表的 ⓘ 点开显示同一段文字（Turnilo 原有行为）。说明文字在 [measure-docs.mjs](</Users/waybi/Desktop/my/turnilo/dc/measure-docs.mjs>) 里按 `cube 名 → 指标名` 维护，`node dc/start.mjs` 启动时套到配置上并写出 `dc/config.live.yaml` 实际加载；只改 `description`，不改公式和数据。

- 新增指标时直接在指标对象里写 `description`，或在 measure-docs.mjs 补一条；两者都没有的指标会自动显示它的公式，启动日志里 `auto-filled` 列出这些指标名，看到就补。
- 原有的组说明（如增长证据每个主题的边界）保留，附在“本组说明”后面。
- 字段含义的核对结论（订单 fees 全 0、到账 net_proceeds 实为售价、订单类交易 subtotal = net_proceeds + 总扣费）来自 2026-10-02 对 9092 实际数据的查询。
- 前端改动：`src/client/components/hover-description/`（说明卡片）、`visualizations/table/table.tsx`（表头悬停；表格的鼠标事件由一层透明的 event-container 统一接收，所以按鼠标横坐标算出是哪一列，不能在表头单元格上直接挂 onMouseEnter）。本机 node-sass 只支持 x64，前端要用 Node 12 构建：`PATH=~/.nvm/versions/node/v12.22.12/bin:$PATH node node_modules/.bin/webpack --config config/webpack.prod.js`（Node 22 下 `npm run build:client` 报 ERR_OSSL_EVP_UNSUPPORTED / Node Sass unsupported）。前端包更新后强制刷新页面即可；说明文字更新要重启 `node dc/start.mjs`。

## 验收与回退

[verify-live.mjs](</Users/waybi/Desktop/my/turnilo/dc/verify-live.mjs>) 请求真实 `/plywood` 接口，校验每个视图行数、两店分量、无其他店记录、所有配置维度可解析、所有指标可计算及新增指标金额总和。首次验收结果写入当前版本verification.json；后续复跑写入带时间戳的新文件，不覆盖证据。

查看本次来源和验收：从latest-run.json读取manifestPath，同行目录为验证结果。原数据与未提交配置备份在 [20261001_2020备份](</Users/waybi/Desktop/my/turnilo/dc/data/backups/20261001_2020/>)；新版本失败不会改旧数据。需要回退时，用旧版本的配置路径运行 `node --max-old-space-size=6144 bin/turnilo --config <旧配置路径> --port 9092 --server-host 127.0.0.1`。不删除旧版本。
