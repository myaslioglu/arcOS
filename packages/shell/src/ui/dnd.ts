"use client";

import { useRef, useState, type DragEvent } from "react";
import {
  acceptedKind,
  decodeDragItem,
  dndMime,
  encodeDragItem,
  type DragItem,
  type DropKind,
} from "../core";

export function dragSourceProps(item: DragItem) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      const { mime, data } = encodeDragItem(item);
      e.dataTransfer.setData(mime, data);
      e.dataTransfer.setData("text/plain", item.address);
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

export function useDropTarget(accepts: readonly DropKind[] | undefined, onItem: (item: DragItem) => void) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child; count them so the highlight doesn't flicker.
  const depth = useRef(0);
  const kindOf = (e: DragEvent) => (accepts ? acceptedKind(Array.from(e.dataTransfer.types), accepts) : null);

  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!kindOf(e)) return;
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!kindOf(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!kindOf(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      const kind = kindOf(e);
      depth.current = 0;
      setOver(false);
      if (!kind) return;
      e.preventDefault();
      const item = decodeDragItem(kind, e.dataTransfer.getData(dndMime(kind)));
      if (item) onItem(item);
    },
  };

  return { over, props };
}
