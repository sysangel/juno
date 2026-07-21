// src/ui/workspace/index.ts
// Public surface of the Observatory (the orchestration workspace). Codex's
// integration lane imports FROM HERE ONLY: the top-level component, the composable
// panes, and the view-model types + pure layout math its adapter targets.
export {
  WIDE_MIN_COLUMNS,
  type OrchestrationWorkspaceProps,
  type OrbitAgentVM,
  type SelectedAgentVM,
  type WorkspaceAgentStatus,
  type WorkspaceFocus,
  type WorkspaceKeyHint,
  type WorkspacePane,
  type WorkspaceStreamEventVM,
  type AssistantTextEventVM,
  type ReasoningEventVM,
  type ToolEventVM,
  type SteeringEventVM,
  type PermissionEventVM,
  type LifecycleEventVM,
} from './types';
export {
  REASONING_MAX_ROWS,
  STEERING_MAX_ROWS,
  eventLines,
  lineWidth,
  orbitOverflowLine,
  orbitRowSegments,
  orbitWindow,
  railWidth,
  statusWord,
  streamHeaderLines,
  streamTail,
  streamViewport,
  summarizeAgents,
  summarySegments,
  workspaceStatusGlyph,
  type StyledLine,
  type StyledSegment,
  type StreamTail,
  type StreamViewport,
  type OrbitWindow,
  type WorkspaceCounts,
} from './layout';
export {
  OrchestrationWorkspace,
  workspaceRenderedRows,
  workspaceStreamWidth,
} from './OrchestrationWorkspace';
export { WorkspaceHeader, headerSides, type WorkspaceHeaderProps } from './WorkspaceHeader';
export { OrbitRail, orbitRailLines, type OrbitRailProps } from './OrbitRail';
export {
  AgentStream,
  STREAM_HEADER_ROWS,
  emptyStreamLines,
  type AgentStreamProps,
} from './AgentStream';
export { WorkspaceFooter, footerText, type WorkspaceFooterProps } from './WorkspaceFooter';
export {
  workspaceKeyHints,
  type WorkspaceActionCapabilities,
  type WorkspaceKeyHintsOptions,
} from './keyHints';
export { StyledLineText, type StyledLineTextProps } from './StyledLineText';
