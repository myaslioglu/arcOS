import { RADAR_FEED_SIZE, type RadarFeedFilter, type RadarRow, type TokenDoc } from "@arcos/data";

// The four radarFeed docs (design 1.6): the first page of Radar for each filter, so one read serves a page. The indexer
// keeps them up to date from the tokens a run changed, without reading the tokens again: a page holds the newest
// matching tokens, so a changed token either joins it, moves in it, or leaves it. Only a full page that loses a row
// can't be completed from what the run knows; the store then rebuilds that page with one query.

/** One Radar row from a token doc. */
export function feedRow(token: TokenDoc): RadarRow {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    source: token.source,
    firstSeen: token.firstSeen,
    passed: token.report?.passed ?? null,
    total: token.report?.total ?? null,
    bestPoolDepth: token.bestPool?.depthUsdc ?? null,
    decimals: token.decimals,
    creator: token.creator,
  };
}

/** Whether a token belongs on a feed, by the flags stored on it. */
export function inFeed(filter: RadarFeedFilter, token: Pick<TokenDoc, "radar">): boolean {
  switch (filter) {
    case "all":
      return true;
    case "liquid":
      return token.radar.liquid;
    case "passing":
      return token.radar.passing;
    case "liquid-passing":
      return token.radar.liquid && token.radar.passing;
  }
}

/** Newest first; a tie on firstSeen goes by address, so every run builds the same page. */
export function rowOrder(a: Pick<RadarRow, "firstSeen" | "address">, b: Pick<RadarRow, "firstSeen" | "address">): number {
  return b.firstSeen.toMillis() - a.firstSeen.toMillis() || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

/**
 * A feed's page after the run changed `changed`: each changed token's old row goes, and a new one comes in if the token
 * still matches; then newest first, one page. `refill` is true when a full page lost a row, since the next matching token
 * may not be among the changed ones.
 */
export function updateFeed(
  rows: readonly RadarRow[],
  changed: readonly TokenDoc[],
  filter: RadarFeedFilter,
  size = RADAR_FEED_SIZE,
): { rows: RadarRow[]; refill: boolean } {
  const touched = new Set(changed.map((token) => token.address));
  const kept = rows.filter((row) => !touched.has(row.address));
  const lost = rows.length - kept.length;
  const added = changed.filter((token) => inFeed(filter, token)).map(feedRow);
  const next = [...kept, ...added].sort(rowOrder).slice(0, size);
  return { rows: next, refill: rows.length >= size && lost > 0 && next.length < size };
}
