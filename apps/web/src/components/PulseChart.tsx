"use client";

import { useQuery } from "@tanstack/react-query";
import { Trace } from "@arcos/shell";
import { pulseCaption, pulseQuery } from "@/lib/pulse-client";

/**
 * The wallpaper's live chart: Arc's gas used per block over the last 1,024 blocks, and its trend. It never holds up
 * the desktop: it draws nothing until its first answer arrives, and keeps its last good answer through a failed refresh.
 */
export function PulseChart() {
  const { data } = useQuery(pulseQuery);
  if (!data) return null;
  return <Trace values={data.ratios} caption={pulseCaption(data.ratios.length)} />;
}
