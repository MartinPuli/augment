"use client";

import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-coral/30 bg-coral/5 p-3 font-mono text-[11px] text-coral">
          {this.props.label} failed to render: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
