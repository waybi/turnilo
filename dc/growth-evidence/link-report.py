#!/usr/bin/env python3
"""Point the growth report's business evidence at native Turnilo overview presets.
Rebuilds from the pre-migration report every time (idempotent); keeps source artifacts.
"""
import json,re,hashlib
from pathlib import Path
base=Path('/Users/waybi/Desktop/my/knowledge-system/noon/store-growth-2026-10-02')
pub=json.loads((Path(__file__).parents[1]/'data/growth-evidence/overview-presets/views.json').read_text());views={v['id']:v for v in pub['views']}
assert pub['cube']=='overview'
def link(id,label=None):return '['+(label or views[id]['title'])+'](<'+views[id]['url']+'>)'
# Report evidence sections (E01–E19 of summary/证据摘要.md, by start line) -> overview presets.
sections=[(5,['monthly','monthly-ads']),(26,['recent','recent-ads','recent-rates']),(33,['bridges']),(43,['products']),(73,['milestones']),(80,['launch']),(91,['launch-products']),(106,['first-orders-113','first-orders-112']),(116,['first-ads-113','first-ads-112']),(126,['decline']),(141,['positive']),(154,['stock']),(201,['inbound','inbound-batches']),(216,['mzh095-orders']),(232,['mzh095-ads']),(253,['weeks','weeks-ads']),(270,['mapping']),(283,['coverage','coverage-current','coverage-september']),(290,['gaps-113','gaps-112','gaps-store']),(296,[])]
def summary_ids(anchor):
 ns=[int(n) for n in re.findall(r'\d+',anchor)]
 if not ns or ns[0]<5:return ['monthly','bridges','milestones','stock']
 start,end=ns[0],ns[-1];ids=[]
 for (a,v),(b,_) in zip(sections,sections[1:]):
  if a<=end and b>start:ids.extend(v)
 if ids==['monthly','monthly-ads']:return ['monthly-113' if start>=15 else 'monthly-112']
 if ids==['recent','recent-ads','recent-rates'] and start==31:return ['recent','recent-ads']
 if ids==['stock']:
  if 180<=start:return ['stock-113']
  if 162<=start and end<=175:return ['stock-112']
 if start==214 and end==214:return ['mzh095-inbound']
 if ids==['bridges'] and start==39:return ['bridge-113-2026-08']
 if ids==['products']:
  if 57<=start<=59:return ['growth-113-2026-08']
  if 62<=start<=71:return ['growth-112-2026-07','bridge-112-2026-07']
 return ids
mapping={'results/sku_monthly.csv':['product-trends'],'evidence/01_order_quality.tsv':['orders'],'evidence/06_ad_quality.tsv':['ads'],'context/09_monthly_sql.tsv':['monthly'],'results/equal_windows.csv':['windows'],'context/17_recent_sync.tsv':['sync'],'context/10_catalog_coverage.tsv':['stock-coverage'],'context/14_inbound.tsv':['inbound-all','inbound-batches'],'evidence/03_current_skus.tsv':['coverage-current'],'summary/priority_gaps.csv':['gaps-113','gaps-112']}
report=base/'一号店二号店-增量来源与破冰复盘.md';audit=base/'audit';audit.mkdir(exist_ok=True);backup=audit/'report.before-turnilo.md'
if not backup.exists():backup.write_text(report.read_text())
original=backup.read_text()
changes=[]
def replace(m):
 label,target=m.groups();path,_,anchor=target.partition('#');ids=None
 if '/summary/证据摘要.md' in path:ids=summary_ids(anchor)
 else:
  for suffix,val in mapping.items():
   if path.endswith('/'+suffix):ids=val;break
 if ids is None:return m.group(0)
 changes.append({'label':label,'old':target,'presets':ids});return '、'.join(link(id,('Turnilo · '+label) if len(ids)==1 else 'Turnilo · '+views[id]['title']) for id in ids)
text=re.sub(r'\[([^\]]+)\]\(<([^>]+)>\)',replace,original)
intro='\n> **交互证据在 Turnilo 总览（overview）里**：'+link('recent','9月 vs 8月')+' · '+link('bridges','增长拆分')+' · '+link('milestones','破冰时间线')+' · '+link('stock','库存证据')+'。每个链接已预设数据集、日期、指标和店铺/商品筛选，打开后可继续拖维度。复盘层（商品月度增减、破冰节点、起步28天）由同一版本订单与广告数据算出，经营截止2026-09-30。完整入口见[Turnilo证据导航](<'+str(base/'Turnilo证据导航.md')+'>)。\n'
text=text.replace('\n## 一、结论先说',intro+'\n## 一、结论先说',1)
text=text.replace('日期沿用库内原始日期，不额外换时区。','日期沿用库内原始日期，不额外换时区。Turnilo使用Etc/UTC作日期坐标，不表示源数据已核实为UTC业务时间。')
text=text.replace('：报告中主要数字对应的表格。','：报告中主要数字对应的表格；每节标题下附 Turnilo 总览入口。')
append='\n### 技术审计归档（不是主要看数入口）\n\n原始快照、CSV和计算程序保持不变。业务证据使用上方 Turnilo 总览链接；需要检查完整SQL和原始文件时，查看[原始核心来源清单](<'+str(base/'evidence/manifest.json')+'>)、[原始补充来源清单](<'+str(base/'context/manifest.json')+'>)、[迁移前报告](<'+str(backup)+'>)。\n\n```bash\n# 核对 Turnilo 总览中全部预设、金额与冻结报告数字\ncd /Users/waybi/Desktop/my/turnilo\nnode dc/growth-evidence/verify.mjs\n```\n'
report.write_text(text+append)
s=base/'summary/证据摘要.md';sb=audit/'summary.before-turnilo.md'
if not sb.exists():sb.write_text(s.read_text())
s0=sb.read_text()
eids=[val for _,val in sections[:-1]]
def heading(m):
 i=int(m.group(1));return m.group(0)+'\n\n**Turnilo 总览：** '+' · '.join(link(x) for x in eids[i-1])
s.write_text(re.sub(r'^## E(\d+) .+$',heading,s0,flags=re.M))
nav=['# 增长与破冰：Turnilo证据导航','','所有入口都打开 Turnilo 的「总览（跨视图）」视图，带预设筛选，不是截图。数据来自当前版本（店铺 112/113），复盘层经营截止 2026-09-30；有效销售额剔除取消/退货/未送达、不是利润；广告归因不是因果；库存快照只代表观察日。','','## 按报告证据查找','']
for i,ids in enumerate(eids,1):nav.append(f'- **E{i:02}** '+' · '.join(link(x) for x in ids))
nav+=['','## 全部预设视图','','| 入口 | 数据集 | 口径提醒 |','|---|---|---|']
for v in pub['views']:nav.append('| '+link(v['id'])+' | '+v['dataset']+' | '+v['caveat'].replace('|','｜')+' |')
nav+=['','## 使用方法','','1. 总览里先看「数据集（子视图）」筛选：订单、广告日报、商品每日快照是明细；「复盘·商品月度增减」「复盘·破冰节点」「复盘·起步28天」是算好的复盘层。每组指标只对自己的数据集生效，不同数据集金额不要相加。','2. “9月 vs 8月”这类入口用的是 Turnilo 原生对比：主数字是当期，灰色小字是上一期和变化率。','3. 库存指标是最小/最大观察值，按日期×商家SKU拆开后即当日读数；不要把多天库存累加。出单商品数、有成交天数按所选范围去重，跨期不要相加。','4. 复盘层的“对比期间”是“前月 → 当月”，日期坐标是当月1日；“类型”维度在复盘层表示增长分类或第N段28天。','5. 若之前已打开 Turnilo，先刷新一次；只在本机 127.0.0.1:9092 可访问。','','复验：在 Turnilo 仓库执行 `node dc/growth-evidence/verify.mjs`。']
(base/'Turnilo证据导航.md').write_text('\n'.join(nav)+'\n')
log={'report':str(report),'cube':'overview','generatedReportSha256':hashlib.sha256(report.read_bytes()).hexdigest(),'convertedEvidenceReferences':len(changes),'nativePresets':len(pub['views']),'changes':changes};(audit/'turnilo-link-migration.json').write_text(json.dumps(log,ensure_ascii=False,indent=2))
print(f'Converted {len(changes)} evidence references to overview presets; E01–E19 linked; {len(pub["views"])} presets in navigation.')
