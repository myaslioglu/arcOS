import { connectErrorMessage } from "@/lib/network";
import { isEmbeddedFrameRefusal } from "@/lib/wallet-frame";

/** The Wallet window's line under the connect buttons. A wallet that took the page for an embedded frame refuses
 * until the page reloads (lib/wallet-frame.ts), so that sentence comes with a button that does it. */
export function ConnectError({ error }: { error: unknown }) {
  return (
    <>
      <p className="mt-3 text-accent-3-text">{connectErrorMessage(error)}</p>
      {isEmbeddedFrameRefusal(error) && (
        <button
          type="button"
          className="mt-2 min-h-8 rounded-lg border border-border-2 px-3 py-1.5 pointer-coarse:min-h-11"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      )}
    </>
  );
}
