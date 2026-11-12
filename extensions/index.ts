import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Type, type Static, type TSchema } from "@sinclair/typebox";

import {
  AgentSession,
  type AgentSessionConfig,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type SessionEntry,
  type SessionStats,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";

import { Box, Component, Container, Text } from "@earendil-works/pi-tui";

import {
  type AgentDetails,
  type AgentStatus,
  type InheritanceOptions,
  type SubagentDeltaEvent,
  type SubagentRetryEvent,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  compressParentContext,
  createToolCallTracker,
  DEFAULT_INHERITANCE,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentDelta,
  emitSubagentRetry,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  formatTokens,
  mapSessionEventToEntry,
} from "./events.js";

import {
  type CwdScope,
  type DashboardAgentSettings,
  type InheritanceCompressionSettings,
  type ResultLimits,
  DEFAULT_SETTINGS,
  getBackgroundIdleTtlSec,
  getBackgroundTimeoutSec,
  getCwdScope,
  getInheritanceCompression,
  getMaxBackgroundPending,
  getMaxConcurrent,
  getMaxIdleBackground,
  getResultLimits,
  getSettingsPath,
  invalidateSettingsCache,
  isBackgroundAllowed,
  isNotifyParentEnabled,
  loadSettings,
  resolveIsolated,
  saveSettings,
  shouldExposeInheritanceInTool,
  shouldInheritByDefault,
} from "./settings.js";

import activate, {
  type AgentMdConfig,
  type AgentMdSource,
  type ModelResolution,
  type PackageAgentIndex,
  type ResolvedAgentMd,
  buildPackageAgentIndex,
  BUNDLED_AGENTS_DIR,
  ensurePackageAgentIndex,
  EXTENSION_ROOT,
  parseAgentMd,
  refreshPackageAgentIndex,
  resolveAgentMdPath,
  resolveModelFromRef,
} from "./agent.js";

// ─── Public re-exports for downstream consumers ─────────────────────────
export {
  type AgentDetails,
  type AgentStatus,
  type InheritanceOptions,
  type SubagentDeltaEvent,
  type SubagentRetryEvent,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  compressParentContext,
  createToolCallTracker,
  DEFAULT_INHERITANCE,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentDelta,
  emitSubagentRetry,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  formatTokens,
  mapSessionEventToEntry,
};

export {
  type CwdScope,
  type DashboardAgentSettings,
  type InheritanceCompressionSettings,
  type ResultLimits,
  DEFAULT_SETTINGS,
  getBackgroundIdleTtlSec,
  getBackgroundTimeoutSec,
  getCwdScope,
  getInheritanceCompression,
  getMaxBackgroundPending,
  getMaxConcurrent,
  getMaxIdleBackground,
  getResultLimits,
  getSettingsPath,
  invalidateSettingsCache,
  isBackgroundAllowed,
  isNotifyParentEnabled,
  loadSettings,
  resolveIsolated,
  saveSettings,
  shouldExposeInheritanceInTool,
  shouldInheritByDefault,
};

// Agent .md frontmatter + 4-tier resolution + role-alias resolver.
// See change: add-agent-md-frontmatter-and-bundled-explore,
//             add-package-agent-discovery-tier (package tier + discovery index).
export {
  type AgentMdConfig,
  type AgentMdSource,
  type ModelResolution,
  type PackageAgentIndex,
  type ResolvedAgentMd,
  buildPackageAgentIndex,
  BUNDLED_AGENTS_DIR,
  ensurePackageAgentIndex,
  EXTENSION_ROOT,
  parseAgentMd,
  refreshPackageAgentIndex,
  resolveAgentMdPath,
  resolveModelFromRef,
};

// Background subagents + plugin hooks on pi.events.
// See change: add-background-subagents.
export {
  type BackgroundCounts,
  type BackgroundRecord,
  type BackgroundStatus,
  type StoredResult,
  type StoppedBy,
  BACKGROUND_ID_PREFIX,
} from "./background.js";
export {
  type AgentCancelDetails,
  type AgentStatusDetails,
  type BackgroundAgentStatus,
  type BackgroundAgentSummary,
  type BackgroundMessagesPage,
  type CancelOutcome,
} from "./background-tools.js";
export {
  type AnswerEvent,
  type DisposedEvent,
  type IdleEvent,
  type MailDroppedEvent,
  type MailEvent,
  type PushEvent,
  type QuestionEvent,
  type SlotEvent,
  type SteerEvent,
  type WaitEvent,
  type BeforeSpawnPayload,
  type BeforeStorePayload,
  type GetQueryPayload,
  type ListQueryPayload,
  type ResultReadEvent,
  type SpawnArgs,
  type StopRequest,
  type SubagentEventMap,
  getBackgroundAgent,
  listBackgroundAgents,
  onSubagentEvent,
  stopSubagent,
  SUBAGENT_CHANNELS,
} from "./hooks.js";
// Orchestration: one AgentControl tool, mailbox / asks / steer, per-child cwd.
// See change: add-subagent-orchestration.
export {
  AGENT_CONTROL_ACTIONS,
  AGENT_CONTROL_TOOL_NAME,
  type AgentControlAction,
} from "./agent-control.js";
export {
  type MailEntry,
  type OutcomeKind,
  type ReplyResult,
  type SteerMode,
  type SteerResult,
} from "./orchestration.js";
export { type CwdRejectReason, type CwdResolution, resolveChildProjectTrust, resolveSubagentCwd } from "./cwd.js";
export {
  ASK_PARENT_TOOL_NAME,
  type CwdRejectDetails,
  type DisposeReason,
  type IdleHandle,
  type LiveSession,
} from "./agent.js";
export {
  type BackgroundSpawnDetails,
  type RunAgentOptions,
  type SpawnLane,
  type SpawnVetoDetails,
  type StopSource,
  SUBAGENT_MANAGEMENT_TOOLS,
} from "./agent.js";

// ─── Extension entry point (pi.ExtensionFactory) ────────────────────────
//
// pi-coding-agent's extension loader looks for the module's default export.
// We re-export `activate` from `./agent.ts` so the registered Agent tool is
// the public entry point of this package.
export default activate;
