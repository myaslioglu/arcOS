import { connectErrorMessage } from "@/lib/network";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "@/lib/wallet-frame";

/** A wallet that took the page for an embedded frame refuses until the page reloads (lib/wallet-frame.ts), so its
 * sentence comes with a button that does it. */
function ReloadButton() {
  return (
    <button
      type="button"
      className="mt-2 min-h-8 rounded-lg border border-border-2 px-3 py-1.5 pointer-coarse:min-h-11"
      onClick={() => window.location.reload()}
    >
      Reload page
    </button>
  );
}

/** The Wallet window's line under the connect buttons. */
export function ConnectError({ error }: { error: unknown }) {
  return (
    <>
      <p className="mt-3 text-accent-3-text">{connectErrorMessage(error)}</p>
      {isEmbeddedFrameRefusal(error) && <ReloadButton />}
    </>
  );
}

/** The Wallet window's line under Switch and Disconnect. `useArcNetwork` hands over a sentence it already mapped, and
 * the embedded-frame refusal is the one sentence that asks for a reload. */
export function SwitchError({ message }: { message: string }) {
  return (
    <>
      <p className="mt-3 text-accent-3-text">{message}</p>
      {message === EMBEDDED_FRAME_MESSAGE && <ReloadButton />}
    </>
  );
}
