# Turnilo 分析视图：用途、数据来源与置信度

**可以确认数据成功导入，但不能把所有视图都当作已审计的经营报表。** 对每个视图应按用途评级：查已有记录通常可用；计算利润、连续日销量、预测精确补货量需要更强证据。

审核范围为两店113/112。本轮重新读取实际配置、导出SQL、data-center源码，对导出文件做数据质量画像，并重新请求当前Turnilo的19个视图。服务端行数和日期范围与版本 `20261001T125009789Z` 一致；该版本在2026-10-01 20:50:09～20:51:20（北京时间）导出，不代表本轮审核时的Noon实时状态。[本轮接口证据](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/live-check.json>)、[本轮数据画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json>)、[上一轮接口验收](</Users/waybi/Desktop/my/turnilo/dc/data/runs/20261001T125009789Z/verification.json>)。

## 1. 数据如何到达BI

```text
Noon商家订单/财务/广告/商品/促销接口 ─┐
本地人工登记或表格导入的采购/成本 ───┤
本地补货算法、任务运行日志 ─────────┤→ data-center MySQL（只取两店）
Noon前台公开竞品信息 ─────────────┘         ↓ 只读导出
                                    带版本的JSON快照
                                          ↓ 启动时加载
                                    Turnilo分析视图
```

Turnilo不直接抓Noon，也不直接实时查询MySQL。网页刷新不会触发源库重新导出。字段日期有三种不同含义：订单/财务的业务日期、当前状态的更新时间、广告报表的区间开始日。所有日期沿用源字符串编码到UTC轴，未做真实时区转换。[导出入口](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L14-L49>)、[时间与刷新限制](</Users/waybi/Desktop/my/turnilo/dc/README.md#L25-L34>)。

## 2. 置信度如何理解

这里不给无依据的80%、95%：没有随机抽样的标准答案和误差测量，不能计算“正确概率”。采用可解释的三个等级：

| 等级 | 可用于什么 | 所需条件 |
|---|---|---|
| 高 | 已核验范围内的确定性事实 | 有源端对账或独立一致性核验，口径匹配这个问题 |
| 中 | 运营排查、已有记录的比较与参考 | 来源和转换可追溯，但全历史完整性、时效或外部真实性没有逐项验证 |
| 低 | 仅作线索，不能单独驱动金额或操作决策 | 周期不明、数据覆盖不足、字段缺值、启发式预测或代理指标 |

**导入一致性：高（限已执行的检查）。业务决策置信度：下面逐个列。** 验收检查了行数、分店数量、日期、可解析字段和可计算指标；新增直加指标核对了文件汇总。它不是全历史逐字段Noon审计，也不证明字段名称符合商业含义。[验收代码](</Users/waybi/Desktop/my/turnilo/dc/verify-live.mjs#L20-L46>)。

订单/交易/账单的较高源端证据仅限此前09-25～10-01、约19:34～19:39在线核对的那次快照；不能外推到后来新增订单或全部历史。[原对账范围](</Users/waybi/Desktop/my/copy/data-center/data-center/output/reconcile_20261001_1926/REPORT.md#L1-L18>)。

## 3. 总表：19 个视图一页看完

记录数、分店数来自当前版本的接口验收（[verification.json](</Users/waybi/Desktop/my/turnilo/dc/data/runs/20261001T125009789Z/verification.json>)）；置信度和限制的依据见下一节逐个视图的证据链接。“置信度”列写法为“用途：等级”，同一视图不同用途等级不同。

| # | 视图 | 一句话作用 | 数据来源 → 库表 | 一行代表 | 记录数（1店/2店） | 置信度（按用途） | 最大限制 |
|---|---|---|---|---|---:|---|---|
| 1 | 订单 | 查商品订单与状态 | Noon 销售后台 → `orders` | 一个订单商品条目 | 7,273（5,532/1,741） | 查记录：中；09-25～10-01 已对账范围：高；算实收/利润：低 | 费用全为 0；销售额含取消/未送达 |
| 2 | 到账明细 | 拆看每笔财务交易 | Noon Payments → `order_transactions` | 一条财务交易 | 7,690（5,797/1,893） | 按类型查：中；已对账范围：高；当银行入账/利润：低 | 付款、费用、调整混在一起 |
| 3 | 结算账单 | 核对结算单据 | Noon Payments → `statements` | 一条财务单据 | 305（196/109） | 分类型查：中；已对账范围：高；默认合计当盈亏：低 | 305 条中只有 97 条是结算账单 |
| 4 | 商品每日快照 | 比较采集日的价格/库存/在售 | Noon 商品列表 → `sku_catalog_metrics` | 某天某商品状态 | 7,546（2,235/5,311） | 时点状态：中；跨天销量/GMV 累计：低 | 96 天里 1店 12 天、2店 40 天有数据；销量周期未证实 |
| 5 | 商品与当前库存 | 查在售状态和库存 | Noon 商品/价格/库存 → `skus` + 本地维护字段 | 一个当前商品 | 324（189/135） | 库存/状态：中；成本利润：低 | 141/324 采购价为 0，148 重量为 0 |
| 6 | 广告分析 | 日报趋势、搜索词效率、广告商品 | Noon 广告接口 → 日报/搜索词/商品三表合并 | 按层不同：活动×天 / 活动×词×报表期 / 商品汇总 | 335,364（177,902/157,462） | 日报趋势：中；1店搜索词单期：中；2店最新搜索词：低；商品层精确日期：低 | 三层不能相加；商品层区间是推算的 |
| 7 | 广告活动当前状态 | 查活动开关/投放方式/日预算 | Noon 活动列表 → `ads` | 一个当前活动 | 176（82/94） | 当前配置：中；历史状态/实际花费：低 | 预算是上限不是花费；无历史 |
| 8 | 1号店搜索词全部窗口 | 单个报表期的原始搜索词 | Noon 搜索词报告 → `ad_search_queries` | 活动×词×报表期 | 1,091,551（全部 1店） | 限定单期：中；跨期累计：不适用 | 报表期互相重叠，记录数不是买家数 |
| 9 | 2号店搜索词全部窗口 | 同上，2店 | 同上 | 同上 | 819,576（全部 2店） | 旧报表期：中；最新期（09-01～10-01）：低 | 最新期 89 活动 vs 前一期 94，翻译全空，完整性待核 |
| 10 | 补货计划 | 筛需要复核补货的商品 | 本地算法（订单销量+库存+在途+时效）→ `procurement_plans` | 计划日×商品的建议 | 4,042（1,862/2,180） | 查“系统建议过什么”：高；照数采购：低 | 规则推算无回测；空运/海运建议不可相加 |
| 11 | 采购批次 | 查登记的采购/发货批次 | 人工录入/装箱单导入 → `purchases` | 一个批次 | 100（66/34） | 内部数量一致：高；外部凭证真实性：中 | 体积全 0、4 批运费 0；未核发票 |
| 12 | 采购商品明细 | 查批次内商品数量 | `purchase_skus` 关联批次 | 批次内一个商品 | 532（351/181） | 与批次一致：高；实物到货：中 | 只有数量，无逐品成本；不可与批次再相加 |
| 13 | 运输成本参数 | 查估算用的费率/汇率/时效 | 人工设置 → `freights` | 每店一条配置 | 2（1/1） | 查配置值：高；当实际运费/实时汇率：低 | 最后修改 2026-08-17，是否仍适用需确认 |
| 14 | 促销活动 | 查平台活动目录与报名状态 | Noon deals 列表 → `promo_deals` | 店铺×活动 | 2,605（1,303/1,302） | 目录参考：中；本店促销效果：低 | 仅 10 条已报名；折扣比例全 0 |
| 15 | 优惠券 | 查券目录与报名状态 | Noon coupons 接口 → `promo_coupons` | 店铺×券 | 76（38/38） | 目录参考：中；消耗/效果：低 | 76 条全未报名，预算/消耗全 0 |
| 16 | 促销商品 | 查已报名活动的商品与状态 | Noon 已报名活动商品 → `sku_deals` | 活动×商家 SKU | 129（74/55） | 参与关系：中；成交价/销量贡献：不适用 | 报名≠审核通过≠成交 |
| 17 | 已绑定竞品 | 比较关注竞品的价格/评价/销量提示 | 人工绑定 + Noon 商品信息 + 前台“近期售出”文案 → `sku_competitors` | 一个绑定竞品 | 3（0/3） | 价格/评价：中；精确销量/份额：低 | 销量是展示值且可能沿用旧值；只 2店 3 条 |
| 18 | 竞品历史快照 | 回看竞品变化 | `sku_competitor_logs` 关联绑定 | 一次抓取结果 | 1,916（0/1,916） | 价格/评价变化：中；销量累计：低 | 同一销量提示会被重复抓到 |
| 19 | 数据同步运行记录 | 排查同步哪步失败 | data-center 任务日志 → `sync_reconciliation_runs` | 一个执行步骤 | 1,366（686/680） | 查运行状态：高；据此断言数据完整：低 | 处理行数可重复；是快照不是实时监控 |

## 4. 每个视图的作用、来源、粒度与置信度（细分）

### ① 订单（orders）

- **作用**：查哪个商品卖了、哪些已送达/退回/取消，以及按SKU和店铺比较订单状态。
- **来源**：Noon销售后台接口 → `orders` → BI。每行是一个订单商品条目item_nr，不是一张含多个商品的结账订单。日期是下单时间，状态是源库同步到的状态。
- **置信度**：查已有条目和状态 **中**；前述已源端对账范围 **高**；默认金额用作实收或利润 **低**。
- **风险**：销售额公式无状态过滤，会包含取消/未送达条目；“客单价”实为条目均价。当前7,273行费用全为0，不表示平台不收费。退货率限定CIR/(Delivered+CIR)，不包含所有失败履约情况。
- **证据**：[Noon到订单字段](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_order.go#L410-L426>)、[BI公式](</Users/waybi/Desktop/my/turnilo/dc/config.yaml#L123-L131>)、[费用画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log#L3>)。

### ② 到账明细（transactions）

- **作用**：拆看销售、订单调整、费用及付款等交易，排查某笔金额为什么变动。
- **来源**：Noon Payments交易列表和费用明细 → `order_transactions`。每行是一条财务交易，非一个订单；同一订单可有多次调整，另有付款/费用记录。日期是交易日期。
- **置信度**：按类型核对平台交易 **中**，已对账列表范围 **高**；直接当银行净到账或利润 **低**。
- **风险**：“净到账”标签对应netProceeds，尚需结合费用和其他项。本快照逐行满足 `netProceeds + totalFees + otherFees = subtotal`（0条超出0.025的误差）；付款、费用、订单调整混加后也不是营业额。未逐笔重新审计费用分类、未核对银行流水。
- **证据**：[源字段映射](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_order.go#L839-L897>)、[分类型与算术检查](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L2218-L2259>)。

### ③ 结算账单（statements）

- **作用**：按店铺、日期、单据类型核对平台结算汇总，排查费用、发票、打款。
- **来源**：Noon Payments账单列表 → `statements`。一行是账单/财务单据的业务键，日期是单据日期；需按币种、类型区分。
- **置信度**：分类型查看平台记录 **中**，前述已对账范围 **高**；默认全类型总额解释为利润、余额或应收 **低**。
- **更正**：之前“305份账单”过于简化。实际为305条混合单据，其中97条 `statement`，其余为15条付款申请、80条invoice、85条payout和28条balance_transfer。全类型应付合计−31,904.15 SAR不能解释为店铺亏损；仅statement的totalDue合计为155,283.89 SAR，也不是净利润。
- **证据**：[抓取与保存](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_finance.go#L716-L769>)、[类型拆分](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L2578-L2628>)。

### ④ 商品每日快照（catalog）

- **作用**：对比已采集日期的售价、库存、是否在售、是否拿到购物车展示位。
- **来源**：Noon商品列表 → `sku_catalog_metrics`；同日同店同商品覆盖更新。一行是一次“当天商品状态”，日期为抓取当天。
- **置信度**：已采集时点的状态参考 **中**；连续日线、销量/GMV/访客跨天累计 **低**。
- **风险**：2026-06-28～10-01共96个自然日，一号店仅12天、二号店40天有记录，不能把空白天视为零销量。源请求未传销量统计周期，响应的unitsSold/gmv/gvs直接写入快照；未证实是当天增量，不能跨天求和。GVS也未证实是去重访客人数。个别库存−1和价格0需按异常值查证。
- **证据**：[快照存储](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/job/catalog_snapshot.go#L17-L28>)、[字段直写](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/job/catalog_snapshot.go#L98-L109>)、[源请求未指定周期](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_sku.go#L2041-L2053>)、[日期覆盖](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L4358-L4372>)。

### ⑤ 商品与当前库存（inventory）

- **作用**：查商品是否在售、平台仓FBN和商家自发货FBP还有多少库存。
- **来源**：Noon商品、价格和库存接口写入 `skus`，叠加本地采购价/重量等维护字段；一行当前商品，日期是该行更新时间。
- **置信度**：快照时点库存与状态 **中**；据此计算完整采购成本/利润 **低**。
- **风险**：不是库存变动流水，没有每天的历史；当前324条中141条采购价为0、148条重量为0，平均成本会被0拉低，不能当免费采购/无重量。采购价、售价的币种不可在未确认转换时直接相减。
- **证据**：[库存源字段与保存](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_sku.go#L1395-L1481>)、[导出字段](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L101>)、[画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log#L9>)。

### ⑥ 广告分析（ads）

- **作用**：日报看花费和广告带来收入的变化；搜索词层找花钱未转化的词；商品层比较广告商品。
- **来源**：Noon广告接口 → `ad_daily_metrics`、`ad_search_queries`、`ad_skus`；拼接为同一视图，按level区分三层，每组指标只计算本层。当前活动名称/状态来自 `ads`。
- **置信度**：日报趋势 **中**；一号店搜索词在选定报表期内 **中**；二号店最新搜索词完整性 **低**；广告商品精确日期比较 **低**。
- **风险**：日报是活动×天；搜索词是活动/广告组×词×整段报告；广告商品是最近一次请求的汇总。三层不能相加。非重叠搜索词仅选了06-18～07-18及09-01～10-01，缺口不补齐，也不能按月精确拆开。广告商品原表未保存请求区间，BI用updated_at往前一个月推算，但源码允许显式覆盖请求日期，推算区间未经证实。广告源端全历史完整性未重新对账。
- **证据**：[分层导出](</Users/waybi/Desktop/my/turnilo/dc/export.mjs#L55-L117>)、[合并与隔离](</Users/waybi/Desktop/my/turnilo/dc/export.mjs#L148-L175>)、[区间可覆盖](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_ad.go#L210-L216>)、[广告API与保存](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_ad.go#L250-L360>)。

### ⑦ 广告活动当前状态（campaigns）

- **作用**：查有哪些活动、是否开启、投放方式及当前日预算。
- **来源**：Noon广告活动列表 → `ads`；一行当前活动/关联广告组信息，日期是数据库更新时间。
- **置信度**：快照中的活动配置 **中**；历史预算、历史开启状态、实际花费 **低/不适用**。
- **风险**：日预算是设置的上限，不是已花的钱；当前关闭不代表历史一直关闭。
- **证据**：[上游活动获取](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_ad.go#L210-L241>)、[导出](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L102>)。

### ⑧ 1号店搜索词全部窗口（search_windows_113）

- **作用**：查一号店某个完整报告期的原始搜索词、点击、花费、订单，核对重复区间。
- **来源**：Noon广告搜索词报告 → `ad_search_queries`，保留一号店所有报告区间；中文列是模型辅助翻译，不是Noon原文。
- **置信度**：限定单报告期使用 **中**；跨重叠期累计或拆成逐日事实 **低/不适用**。
- **风险**：记录不是独立买家人数/搜索次数，一条词可在多个活动和多个报告期出现；历史中文翻译有缺失。否定词决策应按活动/广告组累计完整表现后判断，不能先筛订单为0再加总。
- **证据**：[原始窗口导出](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L113-L116>)、[取数与辅助翻译](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_ad_query.go#L63-L89>)、[各期画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log#L13>)。

### ⑨ 2号店搜索词全部窗口（search_windows_112）

- **作用、来源**：同上，独立保留二号店的数据，方便选同一报告期分析。
- **置信度**：已有旧报告期 **中**；当前最新09-01～10-01报告完整性 **低**。
- **风险**：最新期20,520行、89个活动，而08-30～09-30为48,704行、94个活动，且最新期中文翻译全空。不同窗口自然可能不同，这不是“已证明漏了5个活动”，但缺少完成证据，不能据此断言花费或需求骤降。广告分析的搜索词层已选用这个最新期，因此同受此限制。
- **证据**：[窗口画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log#L14>)、[源码明确updated_at不是完成标志](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_ad_query.go#L135-L141>)。

### ⑩ 补货计划（procurement）

- **作用**：筛出需要人工复核库存、考虑补货的商品，比较不同日期的建议。
- **来源**：本地算法用订单近期销量、FBN库存、在途/采购中数量、运输时效计算 → `procurement_plans`。每行是计划日×商品，仅存需要补货的建议，不是采购订单。
- **置信度**：查看“系统曾建议什么” **高**；预测未来销量及直接照数采购 **低**。
- **风险**：是启发式规则，未提供预测回测误差。代码触发补货后返回目标需求量而非明确扣库存的净缺口，空运/海运两套结果不应直接相加下单；跨计划日期也不能累加成实际采购量。建议只用于待复核列表。
- **证据**：[计划来源与输入](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_procurement_plan.go#L88-L168>)、[补货计算](</Users/waybi/Desktop/my/copy/data-center/data-center/util/replenish.go#L24-L75>)。

### ⑪ 采购批次（purchases）

- **作用**：查登记的采购/发货批次、箱号、数量、运费、重量、入仓和上架日期。
- **来源**：本地人工创建/编辑及装箱清单辅助导入 → `purchases`。每行一批登记记录，按填入日期归属，缺日期回退创建日。
- **置信度**：本地登记的内部数量一致性 **高**；现实采购金额、收货和物流实付真实性 **中**。
- **风险**：未逐笔对供应商发票/物流账单。当前100批数量和532条明细逐批相等，但体积全为0、4批运费为0；不是免费运输的证据。当前导出视图也没有采购总成本这一完整指标。
- **证据**：[人工/表格输入](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_purchase.go#L65-L118>)、[批次画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log#L10-L12>)。

### ⑫ 采购商品明细（purchase_items）

- **作用**：看某批次包含哪些商品、各多少件，用于批次明细核对。
- **来源**：`purchase_skus`关联`purchases`取得店铺和日期；一行是某批次的商品条目。
- **置信度**：与批次登记数量一致性 **高**；实物收货证明 **中**。
- **风险**：仅数量，没有逐商品分摊运费或完整采购金额；不能与父表数量再相加，否则重复算。
- **证据**：[关联导出](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L104-L105>)、[逐批校验](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L4331-L4335>)。

### ⑬ 运输成本参数（freight_settings）

- **作用**：核对系统用于估算的空运/海运费率、汇率和运输天数。
- **来源**：本地成本设置接口 → `freights`；每店一条当前配置，日期是最后修改时间。
- **置信度**：查系统配置值 **高**；现实运费、实时汇率和未来到货时长 **低**。
- **风险**：是人为参数而非财务账单/实时汇率源；两条记录最后修改均为2026-08-17，是否仍适用须人工复核。费率单位要对照配置与算法，不能跨店求和。BI只导出部分参数，并非成本算法的全部输入。
- **证据**：[设置入口](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_customer.go#L1724-L1736>)、[实际参数](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L4336-L4356>)。

### ⑭ 促销活动（promotions）

- **作用**：查平台提供哪些活动、活动起止时间及本店是否参加，再查看已参加活动的展示指标。
- **来源**：Noon deals活动列表 → `promo_deals`，包含未报名活动；一行店铺×活动当前记录。
- **置信度**：活动目录参考 **中**；未筛报名就解释为本店活动、用活动指标推算增量利润 **低**。
- **风险**：2,605行中仅10行标记已参加，不能说开了2,605个促销。折扣比例全部为0，不能直接当成实际没有优惠；GMV原文未确认币种/口径，所以没有强行数值汇总。
- **证据**：[不过滤报名状态的来源](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_promo.go#L64-L137>)、[报名画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L3345-L3368>)。

### ⑮ 优惠券（coupons）

- **作用**：查可参与/已参与券的名称、类型、代码、起止时间，以及源端提供的预算字段。
- **来源**：Noon coupons接口分别抓未参加与已参加列表 → `promo_coupons`；状态由本地根据日期推导，一行店铺×券。
- **置信度**：券目录与源端报名标记 **中**；实际消耗、优惠效果和预算分析 **低**。
- **风险**：当前76行全部标记未参加，预算/已使用预算/适用商品数全为0。现有数据不支持“优惠券花了多少钱、赚了多少”结论，也不是76个实际投放中的券。
- **证据**：[抓取及状态推导](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/usercase_promo.go#L143-L243>)、[券画像](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json#L3372-L3449>)。

### ⑯ 促销商品（deal_items）

- **作用**：查看已报名活动关联哪些商品、商品审核/参与状态及平台显示的活动价。
- **来源**：Noon已报名活动及商品列表 → `sku_deals`；完整抓取、去重后替换当前快照，一行活动×商家SKU。
- **置信度**：快照时参与关系 **中**；实际成交价/活动销售贡献 **低/不适用**。
- **风险**：报名不代表审核通过或已经成交。价格保留原文本，无销量/实际成交记录；需结合商品状态与订单查看。
- **证据**：[完整取数后替换](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/sku_deals.go#L130-L160>)、[导出字段](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L108>)。

### ⑰ 已绑定竞品（competitors）

- **作用**：比较自己明确关注的竞品价格、在售状态、评价数和前台近期销量提示。
- **来源**：本地设置的商品—竞品绑定关系 + Noon商家商品接口；近期销量另由本地工具服务抓Noon前台展示文案 → `sku_competitors`。
- **置信度**：价格/评价的快照参考 **中**；精确销量、市场份额 **低**。
- **风险**：当前仅二号店3条绑定关系，并非全市场。销量来自类似“370+ sold recently”的展示值，不是订单流水，也没有明确固定周期。抓不到时可保留上次销量；取商品失败可把在售设0，不能自动解释为真实下架。
- **证据**：[销量来源](</Users/waybi/Desktop/my/copy/data-center/data-center/commom/http/web_tools.go#L12-L32>)、[失败保留旧值/状态处理](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/sku_competitor.go#L299-L350>)、[分店记录数](</Users/waybi/Desktop/my/turnilo/dc/data/runs/20261001T125009789Z/SYNC_REPORT.md#L22-L23>)。

### ⑱ 竞品历史快照（competitor_history）

- **作用**：回看已绑定竞品的价格、评价和展示状态在各次抓取之间如何变化。
- **来源**：`sku_competitor_logs`关联当前`sku_competitors`取店铺；一行一次抓取状态，不是一笔竞品订单。
- **置信度**：已留存价格/评价变化参考 **中**；将销量求和或做精确销量预测 **低**。
- **风险**：同一个“近期销量”可能被反复抓到，不能按天求和；同样受旧值保留/抓取失败影响。关联当前绑定，不能声称覆盖所有曾经关注过又删除的竞品。跨商品平均数也不能代替单品走势。
- **证据**：[关联和平均口径](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L109-L110>)、[上游抓取限制](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/usercase/sku_competitor.go#L312-L338>)。

### ⑲ 数据同步运行记录（sync_runs）

- **作用**：排查某店某次同步哪个步骤成功、失败或跳过，观察待处理数量及最新业务日。
- **来源**：data-center任务运行结果 → `sync_reconciliation_runs`；每行一个执行中的步骤，不是整次任务，也不是一条订单。
- **置信度**：查看已记录步骤状态 **高**；据成功状态断言全部业务完整 **低**。
- **风险**：一个步骤成功不等于上游每个campaign/每页都完整；同一数据会被不同运行重复处理，sourceRows/storedRows跨运行求和不能当订单数。本视图本身也是旧快照，不能当实时告警；错误原文为保护敏感信息未导出。
- **证据**：[逐步骤写日志](</Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/internal/job/result.go#L231-L250>)、[导出范围](</Users/waybi/Desktop/my/turnilo/dc/sync-all.mjs#L112>)。

## 5. 现在如何使用

- 日常订单和金额排查：先看订单状态，再按交易/单据类型看财务，不能把订单、交易、账单三个金额直接相加。
- 备货：用当前库存及补货建议筛候选，核对采购中/在途、运费参数和真实业务情况后决定数量。
- 广告：优先日层看趋势；搜索词严格单期/非重叠、按活动聚合。二号店最新报告完整性、广告商品真实请求周期需优先复核。
- 商品快照：只比较实际采到的日期和状态；确认销量窗口并补齐采样前，不使用跨天销量、GMV或GVS总和。
- 促销与竞品：用作清单和观察线索，不直接据此证明促销盈利或竞品真实销量。

**优先要修的是指标名称与限制提示，其次才是定时自动刷新。** 自动刷新只能使相同口径更及时，不能让缺失的采购价、未知的统计周期或重叠报告自动变正确。本轮只做解释和质量审核，未修改BI指标、源库或定时任务。

## 6. 复现与证据

从Turnilo根目录运行本轮画像：

```sh
node dc/reviews/20261002-views/profile.mjs
```

这只读当前指针的导出文件；将更新本轮画像输出，若以后指针切到新版本，数字随新版本改变。保持此报告对应的原始数据版本为 `20261001T125009789Z`。

若要再次执行原19视图完整接口验收：

```sh
node dc/verify-live.mjs
```

它不会重新抓Noon或刷新MySQL。复现入口：[画像脚本](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.mjs>)、[画像结果](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile.json>)、[简要输出](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/profile-output.log>)、[接口检查](</Users/waybi/Desktop/my/turnilo/dc/reviews/20261002-views/live-check.json>)。
