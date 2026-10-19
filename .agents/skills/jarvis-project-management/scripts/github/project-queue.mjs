/** Rank a complete issue snapshot. Ranks forecast delivery; Ready is a separate gate. */
export function planQueue(issues) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  if (byId.size !== issues.length) throw new Error('Duplicate issue IDs.');
  const missing = issues.filter(issue => issue.state === 'OPEN' &&
    (typeof issue.milestone !== 'string' || !issue.milestone.trim())).map(x=>x.number).sort((a,b)=>a-b);
  if (missing.length) throw new Error(`Open issues missing milestones: ${missing.map(x=>`#${x}`).join(', ')}. Assign native milestones before refreshing.`);
  const dependencies = new Map();
  const parents = new Map();
  for (const issue of issues) {
    const ids = [...new Set([...issue.blockers, ...issue.children])];
    for (const id of ids) if (!byId.has(id)) throw new Error(`Missing dependency data for #${issue.number}.`);
    dependencies.set(issue.id, ids);
    for (const id of issue.children) parents.set(id, issue);
  }
  const milestone = issue => {
    const value = /^J(0\d?|[1-9]\d*)(?:\s|$)/.exec(issue.milestone ?? '')?.[1];
    const phase = value === undefined ? Infinity : Number(value);
    return Number.isSafeInteger(phase) ? phase : Infinity;
  };
  const priority = issue => Math.min(99, ...issue.labels.filter(x => /^priority:P[0-2]$/.test(x)).map(x => Number(x.at(-1))));
  const sortContext = issue => parents.get(issue.id) ?? issue;
  const compare = (a, b) => milestone(sortContext(a)) - milestone(sortContext(b)) ||
    priority(sortContext(a)) - priority(sortContext(b)) || milestone(a) - milestone(b) ||
    priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
  const pending = new Map(issues.filter(x => x.state === 'OPEN').map(x => [x.id, x]));
  const visited = new Set(issues.filter(x => x.state !== 'OPEN').map(x => x.id));
  const result = [];
  while (pending.size) {
    const available = [...pending.values()].filter(x => dependencies.get(x.id).every(id => visited.has(id))).sort(compare);
    if (!available.length) throw new Error('Dependency/parent cycle: queue not updated.');
    const issue = available[0];
    pending.delete(issue.id);
    visited.add(issue.id);
    if (issue.children.length) continue;
    const unmet = issue.blockers.filter(id => {
      const blocker = byId.get(id);
      return blocker.state !== 'CLOSED' || blocker.stateReason !== 'COMPLETED';
    }).map(id => byId.get(id).number).sort((a,b) => a-b);
    result.push({ number: issue.number, title: issue.title, url: issue.url, rank: result.length + 1,
      status: issue.status, unmet, candidate: issue.status === 'Ready' && unmet.length === 0 });
  }
  return result;
}
