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
} from "@mariozechner/pi-coding-agent";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
} from "@mariozechner/pi-ai";

import { Box, Component, Container, Text } from "@mariozechner/pi-tui";

import {
  type AgentDetails,
  type AgentStatus,
  type InheritanceOptions,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  compressParentContext,
  createToolCallTracker,
  DEFAULT_INHERITANCE,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  formatTokens,
  mapSessionEventToEntry,
} from "./events.js";

import {
  type DashboardAgentSettings,
  type InheritanceCompressionSettings,
  DEFAULT_SETTINGS,
  getInheritanceCompression,
  getSettingsPath,
  invalidateSettingsCache,
  loadSettings,
  resolveIsolated,
  saveSettings,
  shouldExposeInheritanceInTool,
  shouldInheritByDefault,
} from "./settings.js";

import activate from "./agent.js";

// ─── Public re-exports for downstream consumers ─────────────────────────
export {
  type AgentDetails,
  type AgentStatus,
  type InheritanceOptions,
  type SubagentTimelineEntry,
  type TokenUsage,
  buildDetails,
  buildInheritedContext,
  compressParentContext,
  createToolCallTracker,
  DEFAULT_INHERITANCE,
  emitSubagentCompleted,
  emitSubagentCreated,
  emitSubagentFailed,
  emitSubagentProgress,
  emitSubagentStarted,
  formatTokens,
  mapSessionEventToEntry,
};

export {
  type DashboardAgentSettings,
  type InheritanceCompressionSettings,
  DEFAULT_SETTINGS,
  getInheritanceCompression,
  getSettingsPath,
  invalidateSettingsCache,
  loadSettings,
  resolveIsolated,
  saveSettings,
  shouldExposeInheritanceInTool,
  shouldInheritByDefault,
};

// ─── Extension entry point (pi.ExtensionFactory) ────────────────────────
//
// pi-coding-agent's extension loader looks for the module's default export.
// We re-export `activate` from `./agent.ts` so the registered Agent tool is
// the public entry point of this package.
export default activate;
