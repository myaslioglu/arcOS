import type { DropIssue } from "./parse";

const SHOWN = 50;

export function IssuesList({ issues }: { issues: DropIssue[] }) {
  if (issues.length === 0) return null;
  const shown = issues.slice(0, SHOWN);
  const more = issues.length - shown.length;
  return (
    <ul className="mt-2 max-h-32 overflow-auto rounded-md border border-border-2 bg-surface-2 p-2 text-xs text-accent-3-text">
      {shown.map((issue) => (
        <li key={issue.line}>
          Line {issue.line}: {issue.message}
        </li>
      ))}
      {more > 0 && <li className="text-muted">and {more} more</li>}
    </ul>
  );
}
