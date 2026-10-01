// Pure contracts shared by the scoped exporters and offline regression tests.
export function pickWindows(windows) {
  const picked = [];
  for (const w of [...windows].sort((a,b) => String(a.uid).localeCompare(String(b.uid)) || b.e.localeCompare(a.e) || b.s.localeCompare(a.s))) {
    if (![112,113].includes(Number(w.uid)) || !/^\d{4}-\d{2}-\d{2}$/.test(w.s) || !/^\d{4}-\d{2}-\d{2}$/.test(w.e) || w.s > w.e) throw new Error('Invalid scoped report window');
    if (!picked.some(p => p.uid === w.uid && (p.country || '') === (w.country || '') && !(w.e < p.s || w.s > p.e))) picked.push(w);
  }
  return picked;
}
export function scopedFrom(table, alias, owner) {
  if (![table,alias,owner].every(s => /^[a-z][a-z0-9_]*$/.test(s || '')) || !['uid','cid'].includes(owner)) throw new Error('Explicit owner column required');
  return `FROM \`${table}\` ${alias} WHERE ${alias}.${owner} IN (112,113)`;
}
// MySQL 8.1 NULLIF(date_text,'') can become numeric in DATE_FORMAT's context.
// CASE keeps YYYY-MM-DD as text; fallback applies only to absent/invalid strings.
export function dateSQL(expr, fallback) {
  if (![expr,fallback].every(s=>/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s))) throw new Error('Explicit date columns required');
  return `DATE_FORMAT(CASE WHEN ${expr} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${expr} ELSE CAST(${fallback} AS CHAR) END,'%Y-%m-%dT%H:%i:%sZ')`;
}
export function assertOwnedRow(row) {
  if (!['1号店','2号店'].includes(row.store)) throw new Error('Export contains unapproved store');
  if (row.storeId !== undefined && ![112,113].includes(Number(row.storeId))) throw new Error('Export contains unapproved store id');
  if (!row.time || !Number.isFinite(Date.parse(row.time))) throw new Error('Invalid BI time');
}
