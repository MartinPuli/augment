/**
 * Generative-UI canvas contract.
 *
 * The agent places widgets on the canvas with the `canvas_show` tool. Each widget type maps to a
 * React component in ./registry.tsx. The canvas wraps every widget in a branded WidgetFrame
 * (glass card, title bar, materialize animation, focus ring), so widget components render
 * only their inner content.
 */

export interface WidgetSpec<P = Record<string, unknown>> {
  id: string;
  type: string;
  title?: string;
  props: P;
  /** Layout hint. The canvas auto-places widgets; size picks a footprint. */
  size?: "sm" | "md" | "lg" | "xl";
  createdAt: number;
}

export interface WidgetComponentProps<P = Record<string, unknown>> {
  id: string;
  props: P;
  /** Whether the agent / mascot is currently focused on this widget. */
  focused: boolean;
  /**
   * Publish structured state that the agent can read with the `canvas_read` tool
   * (e.g. detection counts, connection status). Throttle to <= 1/s.
   */
  report: (data: Record<string, unknown>) => void;
  /**
   * Send a user-initiated event into the conversation, e.g. "User connected BLE light 'ELK-BLEDOM'".
   * The agent receives it as a user message.
   */
  emit: (text: string) => void;
  /** Merge new props into this widget (e.g. after a user action). */
  update: (patch: Record<string, unknown>) => void;
}
