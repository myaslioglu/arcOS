"use client";

import { Component, type ReactNode } from "react";

type Props = {
  appName: string;
  /** Called once, after render, when a descendant throws — e.g. so the caller can drop a cached
   * lazy component that failed to load (routine when a tab stays open across a redeploy), so the
   * next open retries the import instead of re-throwing the same rejected promise forever. */
  onError?: (error: Error) => void;
  children: ReactNode;
};
type State = { error: Error | null };

/** One crashing app must never take the desktop down with it. */
export class WindowErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="os-crash" role="alert">
        <strong>{this.props.appName} stopped working.</strong>{" "}
        {"Close the window and open it again. If it keeps happening, reload the page."}
        <pre>{this.state.error.message}</pre>
      </div>
    );
  }
}
