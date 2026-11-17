/**
 * Whether an app's first-run explainer (Vault's "What is Vault?", Vesting's "What is Vesting?") is open. It is open
 * until the visitor hides it, and stays hidden in this browser from then on, until they open it again. Kept in
 * localStorage under `arcos.intro.<id>`. Every access is in a try/catch: storage that throws (a private window, blocked
 * site data) only means the choice lasts for this page.
 */

/** What an app's first-run explainer says, in plain words (components/AppIntro.tsx draws it). */
export type IntroContent = {
  /** The question the panel answers: "What is Vault?". */
  title: string;
  /** Two or three short sentences: what the app does. */
  lead: string;
  /** Who it is for, as real examples. */
  uses: readonly string[];
  /** How it works, in three steps. */
  steps: readonly string[];
  /** What it does not do, and what to know before starting. */
  limits: readonly string[];
};

const PREFIX = "arcos.intro.";
const HIDDEN = "hidden";

/** Fired on window whenever this tab changes a choice, so every explainer on the page reads it again. */
export const INTRO_CHANGE_EVENT = "arcos-introchange";

/** Choices storage refused to keep, for this page. */
const unsaved = new Map<string, boolean>();

export const introKey = (id: string) => `${PREFIX}${id}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True while the explainer `id` is open: always, unless this browser kept "hidden" for it. */
export function introOpen(id: string, store: Storage | null = storage()): boolean {
  const kept = unsaved.get(id);
  if (kept !== undefined) return kept;
  try {
    return store?.getItem(introKey(id)) !== HIDDEN;
  } catch {
    return true;
  }
}

/** Opens or hides the explainer `id`, keeps the choice, and tells the page. */
export function setIntroOpen(id: string, open: boolean, store: Storage | null = storage()): void {
  try {
    if (!store) throw new Error("no storage");
    if (open) store.removeItem(introKey(id));
    else store.setItem(introKey(id), HIDDEN);
    unsaved.delete(id);
  } catch {
    unsaved.set(id, open);
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INTRO_CHANGE_EVENT));
}

/** Calls `onChange` when this tab changes a choice, and when another tab does (the `storage` event). */
export function subscribeIntro(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    // A null key is another tab clearing storage altogether.
    if (e.key !== null && !e.key.startsWith(PREFIX)) return;
    unsaved.clear();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(INTRO_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(INTRO_CHANGE_EVENT, onChange);
  };
}
