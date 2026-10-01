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

[build-overview.mjs](</Users/waybi/Desktop/my/turnilo/dc/build-overview.mjs>) 把 17 个数据集（不含两个搜索词全部窗口和广告搜索词/商品层）拼成一张「总览（跨视图）」表，`dataset` 维度就是子视图名；每组指标只对自己的数据集生效，不同数据集金额不要相加。sync-all 每次导出都会自动生成；对已有版本单独补总览用 `node --max-old-space-size=4096 dc/build-overview.mjs`（会写 `config.<run>-overview.yaml` 并更新指针，不重导 MySQL）。

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

## 验收与回退

[verify-live.mjs](</Users/waybi/Desktop/my/turnilo/dc/verify-live.mjs>) 请求真实 `/plywood` 接口，校验每个视图行数、两店分量、无其他店记录、所有配置维度可解析、所有指标可计算及新增指标金额总和。首次验收结果写入当前版本verification.json；后续复跑写入带时间戳的新文件，不覆盖证据。

查看本次来源和验收：从latest-run.json读取manifestPath，同行目录为验证结果。原数据与未提交配置备份在 [20261001_2020备份](</Users/waybi/Desktop/my/turnilo/dc/data/backups/20261001_2020/>)；新版本失败不会改旧数据。需要回退时，用旧版本的配置路径运行 `node --max-old-space-size=6144 bin/turnilo --config <旧配置路径> --port 9092 --server-host 127.0.0.1`。不删除旧版本。
