"use client";

import { Component, type ReactNode } from "react";

type Props = { appName: string; children: ReactNode };
type State = { error: Error | null };

/** One crashing app must never take the desktop down with it. */
export class WindowErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="os-crash" role="alert">
        <strong>{this.props.appName} stopped working.</strong> Close the window and open it again.
        <pre>{this.state.error.message}</pre>
      </div>
    );
  }
}
