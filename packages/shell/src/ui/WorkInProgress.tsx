"use client";

import { ArrowUpRight } from "lucide-react";
import { appHue, stageLabel, type AppManifest } from "../core";

/**
 * A grey app's window: what it is, what it will do, its stage (never a date) and where to follow its progress. The
 * title bar badges it "work in progress" (see `windowLook`). When the app ships, its manifest loses `comingSoon` and
 * this window gives way to the app with no other change.
 */
export function WorkInProgress({ m, repoUrl }: { m: AppManifest; repoUrl?: string }) {
  const stage = stageLabel(m.release);
  return (
    <div className="os-wip" style={{ "--os-hue": appHue(m) } as React.CSSProperties}>
      <div className="os-wip-head">
        <span className="os-icon-tile">
          <m.icon size={20} aria-hidden />
        </span>
        <p className="os-wip-name">{m.name}</p>
      </div>
      <p className="os-wip-blurb">{m.blurb}</p>
      {m.details && m.details.length > 0 && (
        <ul className="os-wip-list">
          {m.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {stage && (
        <p className="os-wip-stage">
          <span className="os-wip-label">Stage</span>
          {stage}
        </p>
      )}
      {repoUrl && (
        <a className="os-wip-link" href={repoUrl} target="_blank" rel="noopener noreferrer">
          Follow progress on GitHub
          <ArrowUpRight aria-hidden />
        </a>
      )}
    </div>
  );
}
