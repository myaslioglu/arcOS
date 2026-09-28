import { queryOptions } from "@tanstack/react-query";
import { parsePulse, type Pulse } from "./pulse";

/** Asks the server for the pulse; throws on an error status or a body that isn't one. */
export async function fetchPulse(fetchFn: typeof fetch = fetch): Promise<Pulse> {
  const res = await fetchFn("/api/pulse");
  if (!res.ok) throw new Error(`/api/pulse answered ${res.status}`);
  return parsePulse(await res.json());
}

/**
 * The chart's query: asked on mount, then every 60 s, and not while the page is hidden (React Query pauses an
 * interval in a background tab unless told otherwise). A failed refresh keeps the last answer on screen; with none,
 * the chart draws nothing.
 */
export const pulseQuery = queryOptions({
  queryKey: ["pulse"],
  queryFn: () => fetchPulse(),
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
  staleTime: 60_000,
  retry: false,
});

/** The chart's caption, naming the window it draws: "arc · observed / trend · last 1,024 blocks". */
export function pulseCaption(blocks: number): string {
  return `arc · observed / trend · last ${blocks.toLocaleString("en-US")} blocks`;
}
