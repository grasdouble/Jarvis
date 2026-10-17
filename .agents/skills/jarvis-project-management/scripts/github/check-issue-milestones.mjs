import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = value => Number.isSafeInteger(value) && value > 0;
const isState = value => value === 'open' || value === 'closed';
const invalid = () => { throw new Error('Invalid issue inventory.'); };

/**
 * Audit complete REST pages from gh api --paginate --slurp with state=all.
 * An empty API result is [[]]; [] is not evidence of a fetched page.
 * Completeness is the caller's responsibility: page contents cannot prove it.
 */
export function findIssuesWithoutMilestones(pages) {
  if (!Array.isArray(pages) || pages.length === 0) invalid();
  const seen = new Set();
  const missing = [];
  for (const page of pages) {
    if (!Array.isArray(page)) invalid();
    for (const issue of page) {
      if (!isObject(issue) || !isNumber(issue.number) || !isState(issue.state)) invalid();
      if (seen.has(issue.number)) invalid();
      seen.add(issue.number);
      // REST lists issues and PRs together. Only a valid PR marker excludes a row.
      if (Object.hasOwn(issue, 'pull_request')) {
        if (!isObject(issue.pull_request) || typeof issue.pull_request.url !== 'string'
          || !/^https:\/\/api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/pulls\/[1-9]\d*$/.test(issue.pull_request.url)) invalid();
        continue;
      }
      const milestone = issue.milestone;
      if (milestone === undefined || milestone === null
        || (typeof milestone === 'string' && !milestone.trim())) {
        missing.push(issue.number);
        continue;
      }
      if (!isObject(milestone) || !isNumber(milestone.number)
        || !isState(milestone.state) || typeof milestone.title !== 'string') invalid();
      if (!milestone.title.trim()) missing.push(issue.number);
    }
  }
  return missing.sort((a, b) => a - b);
}

function main(args) {
  if (args.length !== 1) {
    process.stderr.write('Usage: node .agents/skills/jarvis-project-management/scripts/github/check-issue-milestones.mjs <inventory.json>\n');
    return 2;
  }
  try {
    const missing = findIssuesWithoutMilestones(JSON.parse(readFileSync(args[0], 'utf8')));
    if (missing.length) {
      // Never render API titles, URLs, error details or Actions annotations.
      for (const number of missing) process.stdout.write(`https://github.com/grasdouble/Jarvis/issues/${number}\n`);
      process.stderr.write(`Issues without a native milestone: ${missing.length}.\n`);
      return 1;
    }
    process.stdout.write('All issues have a native milestone.\n');
    return 0;
  } catch {
    process.stderr.write('Invalid issue inventory.\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
