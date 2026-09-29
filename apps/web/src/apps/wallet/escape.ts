/**
 * Keeps Escape from closing the window that calls this, until the function it returns is called.
 *
 * The WalletConnect modal closes on Escape, and so does the shell's window frame, and the frame acts first: it listens on the
 * document as the key bubbles up, the modal on the window after it. The Wallet window would close under the modal and take the
 * "You cancelled the request in your wallet." sentence with it. The frame leaves a key that is already handled alone (see
 * `shouldEscapeCloseWindow`) and the modal doesn't look, so this listener marks Escape handled, in the capture phase to run
 * ahead of both, and the modal still closes as usual.
 */
export function holdEscape(target: EventTarget): () => void {
  const onKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") event.preventDefault();
  };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
