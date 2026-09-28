"use client";

import { appHue, roadmapEntries, type AppManifest } from "../core";

/** The Roadmap: every grey app, its stage and its blurb, built from the manifests (see `roadmapEntries`). */
export function RoadmapWindow({ apps }: { apps: readonly AppManifest[] }) {
  const entries = roadmapEntries(apps);
  if (entries.length === 0) return <p className="os-empty">No apps are in progress.</p>;
  return (
    <div className="os-roadmap">
      <p className="os-roadmap-intro">The apps on the way, soonest first.</p>
      <ul className="os-roadmap-list">
        {entries.map(({ app, stage }) => (
          <li key={app.id} className="os-roadmap-row" style={{ "--os-hue": appHue(app) } as React.CSSProperties}>
            <span className="os-icon-tile os-icon-tile--sm">
              <app.icon size={16} aria-hidden />
            </span>
            <span className="os-roadmap-text">
              <span className="os-roadmap-name">{app.name}</span>
              <span className="os-roadmap-blurb">{app.blurb}</span>
            </span>
            <span className="os-roadmap-stage">{stage}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
