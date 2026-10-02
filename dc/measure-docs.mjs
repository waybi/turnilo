// Hover explanations for every Turnilo measure: cube name -> measure name -> markdown.
// Applied at startup (dc/start.mjs) on top of the generated config; only `description` is touched,
// never formulas or data. A measure missing here still gets an auto text with its formula.
// Facts below were checked against the served data on 2026-10-02 (see dc/README.md "指标说明").
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const doc = (what, how, note) => [what, how && `**怎么算：**${how}`, note && `**注意：**${note}`].filter(Boolean).join('\n\n');

const ORDER_SCOPE = '订单表一行=一个商品条目（item_nr），一单买 3 件就是 3 行，不是结账订单数。';
const ADS = (layer, scope) => ({
  spends: doc(`${layer}广告花费，单位 SAR。`, '花费字段求和。', scope),
  revenue: doc(`${layer}广告带来的销售额（Noon 广告后台归因，SAR）。`, '归因销售额求和。', '是平台归因口径，含本来就会自然成交的单，不能当作广告净增量，也不能从订单销售额里扣出“自然销售”。' + (scope ? ' ' + scope : '')),
  orders: doc(`${layer}广告归因订单数。`, '归因订单求和。', '与订单表不是同一口径，无法逐单匹配。' + (scope ? ' ' + scope : '')),
  clicks: doc(`${layer}广告点击次数。`, '点击求和。', scope),
  views: doc(`${layer}广告曝光次数。`, '曝光求和。', scope),
  atc: doc(`${layer}广告带来的加购次数。`, '加购求和。', scope),
  roas: doc('广告投入产出比：每花 1 SAR 广告费带回多少 SAR 归因销售额。', '广告销售额 ÷ 花费。', '不是利润率。是否赚钱要和保本 ROAS 比（两店利润率不同，保本线要分店算）。' + (scope ? ' ' + scope : '')),
  cpc: doc('平均每次点击花多少钱（SAR）。', '花费 ÷ 点击。', scope),
  ctr: doc('点击率：看到广告的人里有多少点了。', '点击 ÷ 曝光。', scope),
  cvr: doc('转化率：点了广告的人里有多少下单。', '广告订单 ÷ 点击。', scope)
});
const QUERY_SCOPE = '搜索词层每店只取一个最新且不重叠的完整报表期，时间轴是报表期开始日，不能拿来看日趋势。';
const SKU_SCOPE = '商品层是每个广告商品最近 1 个月的汇总快照，不是每日数据。';
const prefix = (p, o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));

const EFFECTIVE = '剔除 CIR（客户退货）、Could Not Be Delivered（没送到）、Cancelled（已取消）三种状态后的商品行；还在配送中的（Shipped/Processing 等）也算在内。';
const GROWTH = {
  records: doc('证据表的行数。', '行数计数。', '不同证据主题的一行代表不同东西，这个数不是销量，也不是订单数。'),
  sales: doc('有效销售额（SAR）：卖出去且没被退货、取消、拒收的商品售价合计。', `订单 OfferPrice 求和，只算${EFFECTIVE}`, '是售价，不是利润，没扣平台佣金、配送费、采购和头程成本。'),
  items: doc('有效商品条目：卖出去且没被退货、取消、拒收的商品件数。', `订单商品行计数，只算${EFFECTIVE}一行=一个 item_nr，一单买 3 件记 3。`, '比“已送达条目”多，因为在途的也算。有效销售额 ÷ 有效商品条目 = 每件均价（不是客单价）。'),
  delivered: doc('已送达金额（SAR）：状态为 Delivered 的商品售价合计。', '只算 status = Delivered 的行。', '最保守的成交口径；最近几天的订单很多还在路上，会偏低。'),
  deliveredItems: doc('已送达的商品条目数。', '只数 status = Delivered 的行。'),
  all: doc('所有状态的商品条目数，包含退货、取消、没送到。', '订单商品行全部计数。'),
  returns: doc('CIR（客户退货）的商品条目数。', 'status = CIR 的行数。', '退货率口径 = CIR ÷ (Delivered + CIR)。'),
  cancels: doc('已取消的商品条目数。', 'status = Cancelled 的行数。'),
  failed: doc('没送到（Could Not Be Delivered）的商品条目数。', '对应状态的行数。'),
  asp: doc('有效条目成交均价（SAR/件）。', '有效销售额 ÷ 有效商品条目。', '是每件商品均价，不是每单客单价。'),
  spend: doc('广告花费（SAR）。', '来自广告日报 ad_daily_metrics 求和。'),
  adRevenue: doc('广告归因额（SAR）：Noon 广告后台把成交算到广告头上的金额。', '广告日报 revenue 求和。', '平台归因，含本来会自然成交的单；不能从订单额里扣出自然销售额，也不是增量。'),
  revenue: doc('广告归因额（SAR）：Noon 广告后台把成交算到广告头上的金额。', '广告日报 revenue 求和。', '平台归因，不是增量，不能与订单逐单匹配。'),
  adOrders: doc('广告归因订单数。', '广告日报 orders 求和。', '与订单表口径不同。'),
  orders: doc('广告归因订单数。', '广告日报 orders 求和。', '与订单表口径不同。'),
  clicks: doc('广告点击次数。', '广告日报 clicks 求和。'),
  views: doc('广告曝光次数。', '广告日报 views 求和。'),
  roas: doc('广告 ROAS：每花 1 SAR 带回多少 SAR 归因销售额。', '广告归因额 ÷ 广告花费。', '不是利润。是否赚钱要和分店计算的保本 ROAS 比。'),
  sellingProducts: doc('当月有过有效成交的不同商品（PSKU）个数。', '有效商品条目 > 0 的 PSKU 去重计数，按月预先算好。', '同一商品跨月会重复出现，不能把多个月相加；取的是单月最大值。'),
  sellingDays: doc('当月至少有 1 件有效成交的天数。', '按月预先算好。', '不能跨月相加。'),
  days: doc('窗口或月份的日历天数，用来算日均。', '预先写入。', '不能相加。'),
  dailySales: doc('月度日均有效销售额（SAR/天）。', '有效销售额 ÷ 当月日历天数。', '起步月不完整，日均会偏低。'),
  change: doc('9 月有效销售额相对 8 月的变化率。', '9月有效销售额 ÷ 8月有效销售额 − 1。', '固定比较 8 月和 9 月，只能按店铺拆，不能再按月份拆。'),
  dailyChange: doc('9 月日均有效销售额相对 8 月日均的变化率，排除两个月天数不同（30 vs 31）的影响。', '(9月销售额÷30) ÷ (8月销售额÷31) − 1。', '只能按店铺拆。'),
  spendChange: doc('9 月广告花费相对 8 月的变化率。', '9月花费 ÷ 8月花费 − 1。', '只能按店铺拆。'),
  before: doc('前一个月该商品的有效销售额（SAR）。', '按店铺×相邻两月×PSKU 预先算好。'),
  after: doc('当月该商品的有效销售额（SAR）。', '按店铺×相邻两月×PSKU 预先算好。'),
  delta: doc('该商品当月比上月多卖（或少卖）的有效销售额（SAR）。', '当月 − 前月。', '正数=增长贡献，负数=下滑拖累；所有商品加起来=全店变化。'),
  beforeItems: doc('前一个月该商品的有效商品条目。'),
  afterItems: doc('当月该商品的有效商品条目。'),
  volume: doc('老品销量效应（SAR）：老品因为卖的件数变化带来的金额变化。', '(当月件数 − 前月件数) × 两月均价的平均。', '只对两个月都有成交的老品算；与均价效应相加 = 老品增额。是算术拆分，不是因果。'),
  price: doc('老品均价效应（SAR）：老品因为每件均价变化带来的金额变化。', '(当月均价 − 前月均价) × 两月件数的平均。', '与销量效应相加 = 老品增额。'),
  net: doc('全店净增额（SAR）：当月有效销售额 − 上月有效销售额。', '老品增额 + 首次出单 + 恢复成交 + 本月无成交（负数）。'),
  old: doc('老品增额（SAR）：上月和当月都有成交的商品贡献的变化。'),
  first: doc('首次观察出单（SAR）：本月第一次在本地数据里出现有效成交的商品带来的金额。', '', '“首次观察”是本地数据里的首次，不等于上架日。'),
  reactivate: doc('恢复成交（SAR）：以前卖过、上月没卖、本月又卖了的商品金额。'),
  lapsed: doc('本月无成交（SAR，通常为负）：上月有成交、本月一件没卖的商品少掉的金额。'),
  oldShare: doc('老品增额占全店净增额的比例。', '老品增额 ÷ 全店净增额。', '分母是净变化，净变化很小或为负时比例会很夸张。'),
  events: doc('破冰里程碑节点个数（首单、累计 10/50/100 件、首次 7 天里 5 天有成交等）。', '每个节点一行。', '日期是本地历史观察到的日期，不是开店或上架日。'),
  products: doc('该 28 天窗口内有过有效成交的不同商品个数。', '', '不能跨窗口相加。'),
  top3: doc('该窗口销售额前三的商品合计有效销售额（SAR）。'),
  ratio: doc('广告归因额 ÷ 有效销售额。', '', '不是“广告带来的订单占比”，归因额会和自然成交重叠。'),
  top3share: doc('前三商品销售额占窗口有效销售额的比例，看是否靠少数爆品。', '前三商品销售额 ÷ 有效销售额。'),
  stockMin: doc('所选范围内 FBN（Noon 仓）库存快照的最小值。', '快照取最小值，不相加。', '按“日期×商品”拆开时，最小=最大就是当天读数；快照只在观察日有，不能推断连续缺货天数。'),
  stockMax: doc('所选范围内 FBN 库存快照的最大值。', '快照取最大值，不相加。'),
  fbp: doc('FBP（卖家自发货）库存快照的最大值。'),
  priceMin: doc('快照售价最小值（SAR）。'),
  priceMax: doc('快照售价最大值（SAR）。'),
  live: doc('可售标记最小值：1=当天可售，0=不可售。', '取最小值，只要有一个快照不可售就显示 0。'),
  issues: doc('商品快照里的问题数最大值（平台提示的 listing 问题）。'),
  units: doc('该采购批次里这个商品的发货数量。', '', '日期按发货日；没填送仓日期不代表没到。'),
  rows: doc('记录行数。'),
  current: doc('截至 9 月 30 日的当前商品数。'),
  never: doc('当前商品里，本地数据从没出现过有效成交的商品数。', '', '不是新品失败率，因为没有可靠的上架日期。'),
  september: doc('当前商品里 9 月有过有效成交的商品数。'),
  aug: doc('主力品 8 月有效销售额（SAR）。'),
  sep: doc('主力品 9 月有效销售额（SAR）。'),
  decline: doc('主力品 9 月比 8 月少卖的有效销售额（SAR）。'),
  equal: doc('按 8 月日均折算 30 天后的缺口（SAR），去掉天数差影响。', '', '不是收益预测。'),
  share: doc('主力品下滑占全店下滑的比例。', '', '是算术分解，不能全部归因于缺货或停投。'),
  observed: doc('核验项目的观测值或记录行数。', '', '具体含义看“核验项目”维度。'),
  difference: doc('核验项目的差值或异常数，0 表示核对一致。'),
  stock: doc('抽取时的当前 FBN 库存。', '', '是当前读数，不能反推历史。')
};
const growthDocs = () => {
  // Measure names are "<layerKey>_<metric>"; the layer caveat (existing description) is appended.
  const out = { records: GROWTH.records };
  return new Proxy(out, { get: (t, k) => typeof k === 'string' ? (t[k] ?? GROWTH[k.split('_').slice(1).join('_')]) : undefined });
};

export const MEASURE_DOCS = {
  overview: {
    count: doc('当前筛选下所有数据集的记录行数。', '行数计数。', '不同数据集一行代表不同东西（订单条目、广告日报、快照…），这个数只用来看数据量。看具体业务请先按“数据集”拆开。'),
    o_count: doc('订单商品条目数，包含所有状态（含退货、取消、没送到）。', '订单数据集行数。', ORDER_SCOPE),
    o_sales: doc('订单金额（SAR），包含所有状态。', '订单数据集 price（售价）求和。', '含取消、退货、没送到的订单，会比真实成交高；要看有效成交请按“状态”筛掉 CIR / Could Not Be Delivered / Cancelled，或看已送达金额。不是利润。'),
    o_delivered: doc('已送达金额（SAR）：状态为 Delivered 的商品售价合计。', '订单数据集中 status = Delivered 的 price 求和。', '最近几天的订单多数还在路上，会偏低。'),
    o_returnRate: doc('退货率：已经有结果的订单里，被客户退货的比例。', 'CIR 条目数 ÷ (Delivered + CIR 条目数)。', '取消、没送到、在途的不进分母。'),
    t_net: doc('到账明细里的 net_proceeds 字段合计（SAR）。', '到账明细 netProceeds 求和。', '2026-10-02 核对：这个字段和订单售价按订单号一一对上，**实际是售价，不是扣费后的到手钱**。到手看“到账 · 小计”。'),
    t_fees: doc('平台扣费合计（SAR，负数）：佣金 + FBN 出库费及其增值税。', '到账明细 totalFees 求和。', '只有 order / order_update 两类交易有值；账单费、打款等类型的金额记在“其他费用”，不在这里。'),
    t_subtotal: doc('到账小计（SAR）：扣掉平台费后真正到手的钱。', '到账明细 subtotal 求和；订单类交易满足 小计 = net_proceeds + 扣费。', '算利润用这个。但 payment（打款）、statement_fee、balance_transfer 类型也是负数小计，混在一起加总不代表亏损，请先按“类型”拆开只看 order / order_update。'),
    s_due: doc('结算账单的应付合计（SAR）。', '账单 totalDue 求和。', '账单分 statement / invoice / payout / payment_request 等类型，正负方向各不相同，**必须先按“类型”拆开**；混在一起的负数不代表亏损。'),
    s_net: doc('结算账单净收入（SAR）。', '账单 netProceeds 求和。', '先按类型拆开看。'),
    s_fees: doc('结算账单费用（SAR）。', '账单 fees 求和。', '先按类型拆开看。'),
    a_spend: ADS('', '').spends, a_revenue: ADS('', '').revenue, a_orders: ADS('', '').orders, a_roas: ADS('', '').roas,
    c_units: doc('商品快照里的销量读数。', '快照 unitsSold 求和。', '这是 Noon 卖家后台某个统计区间的读数，没证明是每日增量，**跨天相加没有意义**，只按单日看。快照很稀疏（1号店 12 天、2号店 40 天）。'),
    c_avgPrice: doc('商品快照里的平均售价（SAR）。', '快照 price 平均值。'),
    c_skus: doc('有快照的不同商品（SKU）个数。', 'SKU 去重计数。'),
    i_fbn: doc('当前 FBN（Noon 仓）库存件数。', '当前商品表 fbnStock 求和。', '是抽取时的当前值，日期是记录更新时间，不是历史库存。'),
    i_fbp: doc('当前 FBP（卖家自发货）库存件数。', '当前商品表 fbpStock 求和。', '是当前值，不是历史。'),
    p_air: doc('补货计划里建议空运的件数。', '补货计划 airQty 求和。', '是系统按目标需求算的建议量，不是真实采购量；不同计划日期是不同版本，跨日期不能相加；空运和海运是二选一的方案，不要相加。'),
    p_sea: doc('补货计划里建议海运的件数。', '补货计划 seaQty 求和。', '同上：建议量、不同版本不可累加。'),
    b_units: doc('采购批次的采购总件数。', '采购批次 units 求和。', '与“采购明细 · 商品数”是父子两层，同一批货，不要相加。'),
    b_freight: doc('采购批次运费合计（单位以源表为准，未确认币种）。', '采购批次 freight 求和。'),
    bi_units: doc('采购明细里各商品的件数。', '采购商品明细 units 求和。', '与采购批次件数是同一批货的两层，不要相加。'),
    d_sold: doc('促销活动后台显示的活动销量。', '促销活动 itemsSold 求和。', '是活动当前快照，不是按日增量。'),
    k_price: doc('已绑定竞品的平均售价（SAR）。', '竞品当前与历史快照 price 平均。'),
    k_sold: doc('竞品“最近售出”展示数的平均值。', '竞品快照 sold 平均。', '来自页面上的 sold recently 提示，可能保留旧值，只能当参考。'),
    r_source: doc('数据同步每次处理的来源行数。', 'sourceRows 求和。', '每次运行都会重复处理，跨运行相加不是订单数。')
  },
  ads: { ...prefix('d_', ADS('日报层：', '')), ...prefix('q_', ADS('搜索词层：', QUERY_SCOPE)), ...prefix('s_', ADS('商品层：', SKU_SCOPE)),
    q_uniq: doc('不同搜索词的个数。', '搜索词去重计数。', QUERY_SCOPE),
    s_uniq: doc('投放的不同商品（SKU）个数。', 'SKU 去重计数。', SKU_SCOPE) },
  orders: {
    count: doc('订单商品条目数，包含所有状态。', '行数计数。', ORDER_SCOPE),
    sales: doc('销售额（SAR），包含所有状态。', 'price（售价 base_price）求和。', '含取消、退货、没送到，按“订单状态”筛掉 CIR / Could Not Be Delivered / Cancelled 才是有效成交。不是利润。'),
    avgPrice: doc('每个商品条目的平均售价（SAR）。', 'price 平均值。', '名字叫客单价，实际是**每件均价**，不是每笔结账订单的金额。'),
    fees: doc('订单表里的平台费用字段。', 'fees 求和。', '2026-10-02 核对该字段全部为 0（源表未回填），不要用；平台费看到账明细的“总扣费”。'),
    returnRate: doc('退货率。', 'CIR 条目数 ÷ (Delivered + CIR 条目数)。', '取消、没送到、在途的不进分母。')
  },
  transactions: {
    netProceeds: doc('到账明细的 net_proceeds 字段合计（SAR）。', 'netProceeds 求和。', '核对后发现它和订单售价按订单号一一对上，**实际是售价**，不是到手钱；到手看“小计”。'),
    subtotal: doc('小计（SAR）：扣掉平台费后真正到手的钱。', 'subtotal 求和；订单类交易满足 小计 = net_proceeds + 总扣费。', '算利润用它。payment（打款）、statement_fee 等类型也是负数小计，请先按“交易类型”拆开。'),
    totalFees: doc('总扣费（SAR，负数）：佣金 + FBN 出库费及增值税。', 'totalFees 求和。', '只有 order / order_update 有值。'),
    referralFee: doc('佣金（SAR，负数，不含增值税）。', 'referralFee 求和。', 'order_update（退款调整）里会出现正数退回。'),
    fbnFee: doc('FBN 出库费（SAR，负数，不含增值税）：Noon 仓拣货配送的费用。', 'fbnFee 求和。'),
    otherFees: doc('其他费用（SAR）。', 'otherFees 求和。', '主要是 payment（打款给你）、statement_fee（账单费）、balance_transfer（余额划转），不是订单成本，不要和佣金加在一起算费率。'),
    count: doc('到账明细笔数。', '行数计数。', '一个订单可能有多笔（订单 + 调整）。')
  },
  catalog: {
    unitsSold: doc('商品快照的销量读数。', 'unitsSold 求和。', '读数没证明是每日增量，**跨天相加没有意义**，只按单日看；快照稀疏。'),
    gmv: doc('商品快照的 GMV 读数（SAR）。', 'gmv 求和。', '同销量，只按单日看；与销量×当前价对不上，是平台口径。'),
    gvs: doc('商品详情页访客数（GVS）读数。', 'gvs 求和。', '只按单日看，不能跨天加。'),
    avgPrice: doc('快照平均售价（SAR）。', 'price 平均值。'),
    avgFbnStock: doc('快照 FBN 库存平均值。', 'fbnStock 平均值。', '按“快照日期×商品”拆开看才是当天读数。'),
    avgFbpStock: doc('快照 FBP 库存平均值。', 'fbpStock 平均值。'),
    skuCount: doc('有快照的不同商品个数。', 'SKU 去重计数。')
  },
  statements: {
    count: doc('结算账单份数。'),
    netProceeds: doc('账单净收入（SAR）。', '', '先按“交易类型”拆开，不同类型正负方向不同。'),
    fees: doc('账单费用（SAR）。', '', '先按类型拆开。'),
    others: doc('账单其他项（SAR）。', '', '先按类型拆开。'),
    totalDue: doc('应付合计（SAR）= 净收入 + 费用 + 其他。', '', 'statement / invoice / payout 等混加的负数不代表亏损，必须按类型拆开。')
  },
  inventory: {
    count: doc('当前商品个数。'),
    price: doc('当前平均售价（SAR）。'),
    purchasePrice: doc('当前平均采购价（人民币，源表值）。', '', '覆盖不全，部分商品没填。'),
    fbnStock: doc('当前 FBN 库存件数。', '', '是抽取时的当前值，不是历史库存。'),
    fbpStock: doc('当前 FBP 库存件数。', '', '当前值。'),
    weight: doc('平均重量（源表单位）。')
  },
  campaigns: { count: doc('广告活动/广告组条数。'), budget: doc('当前配置的日预算合计。', '', '是配置值，不是实际花费。') },
  procurement: {
    count: doc('补货计划行数（计划日期×商品）。'),
    fbnStock: doc('计划生成时参考的库存平均值。'),
    dailySales: doc('计划使用的平均日销量。'),
    airQty: doc('建议空运件数。', '', '是目标需求，不是真实采购；不同计划日期是不同版本，不能累加；与海运二选一。'),
    seaQty: doc('建议海运件数。', '', '同上。')
  },
  purchases: {
    count: doc('采购批次数。'), units: doc('批次采购件数。', '', '与采购商品明细是同一批货的两层，不要相加。'),
    freight: doc('批次运费（源表单位）。'), weight: doc('批次重量（源表单位）。'), volume: doc('批次体积（源表单位）。')
  },
  purchase_items: { count: doc('采购明细行数（批次×商品）。'), units: doc('明细商品件数。', '', '不重复分摊整批运费。') },
  promotions: { count: doc('促销活动个数。'), discountPct: doc('平均折扣比例。'), itemsSold: doc('活动后台显示的活动销量。', '', '当前快照，不是按日增量。') },
  coupons: { count: doc('优惠券个数。'), budget: doc('优惠券预算。'), burnt: doc('已用掉的优惠券预算。'), products: doc('适用商品数合计。') },
  deal_items: { count: doc('活动×商品参与记录数。') },
  competitors: { count: doc('已绑定竞品数。'), price: doc('竞品平均售价（SAR）。'), sold: doc('竞品“最近售出”展示数平均值。', '', '来自页面提示，可能保留旧值，不能按抓取次数累计。'), ratingCount: doc('竞品平均评价数。') },
  competitor_history: { count: doc('竞品抓取快照次数。'), price: doc('竞品快照平均售价（SAR）。'), sold: doc('竞品“最近售出”展示数平均值。', '', '快照值，不跨时点相加。'), ratingCount: doc('竞品快照平均评价数。') },
  freight_settings: { count: doc('运费参数记录数。'), airFee: doc('空运费率（当前参数）。'), shippingFee: doc('海运费率（当前参数）。'), exchangeRate: doc('换算汇率（当前参数）。'), airDays: doc('空运天数。'), shippingDays: doc('海运天数。') },
  sync_runs: { count: doc('同步任务步骤数。'), sourceRows: doc('每次运行从来源读到的行数。', '', '跨运行相加不是订单数。'), storedRows: doc('每次运行写入本地的行数。'), pendingRows: doc('待处理行数。') },
  growth_evidence_202609: growthDocs()
};
for (const uid of ['113', '112']) {
  const scope = '保留全部原始报表期（含重叠），**先选一个报表期**再看，跨报表期相加会重复计算。';
  MEASURE_DOCS['search_windows_' + uid] = {
    count: doc('搜索词报表行数。', '', scope),
    views: doc('搜索词曝光。', '', scope), clicks: doc('搜索词点击。', '', scope), orders: doc('搜索词归因订单。', '', scope),
    atc: doc('搜索词加购。', '', scope), spends: doc('搜索词花费（SAR）。', '', scope), revenue: doc('搜索词归因销售额（SAR）。', '', scope),
    bid: doc('平均出价（SAR）。'), effectiveBid: doc('平均实际生效出价（SAR）。')
  };
}

function flatten(items) { return items.flatMap(m => m.measures ? flatten(m.measures) : [m]); }

// Returns { config, stats } with descriptions filled; never changes anything except `description`.
export function applyMeasureDocs(config) {
  const stats = { written: 0, auto: 0, missing: [] };
  for (const cube of config.dataCubes) {
    const docs = MEASURE_DOCS[cube.name] || {};
    for (const m of flatten(cube.measures || [])) {
      const own = docs[m.name];
      const prior = m.description && m.description.trim();
      if (own) {
        m.description = prior && !own.includes(prior) ? `${own}\n\n**本组说明：**${prior}` : own;
        stats.written++;
      } else {
        const auto = `**怎么算：**\`${m.formula}\``;
        m.description = prior ? `${prior}\n\n${auto}` : auto;
        stats.auto++; stats.missing.push(cube.name + '/' + m.name);
      }
    }
  }
  return { config, stats };
}

export function writeWithDocs(inputPath, outputPath) {
  const config = yaml.safeLoad(readFileSync(inputPath, 'utf8'));
  const { stats } = applyMeasureDocs(config);
  writeFileSync(outputPath, yaml.safeDump(config, { lineWidth: 140, noRefs: true }), { mode: 0o600 });
  console.log(`Measure docs: ${stats.written} written, ${stats.auto} auto-filled${stats.missing.length ? ' (' + stats.missing.slice(0, 8).join(', ') + (stats.missing.length > 8 ? ', …' : '') + ')' : ''}`);
  return { outputPath, stats };
}
