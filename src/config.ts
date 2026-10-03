import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const tiers = ["low", "medium", "high"] as const;
// The final assertion requires the true end of input (unlike $, which accepts a trailing newline).
export const modelIdPattern = "^[^/\\s]+/\\S+(?![\\s\\S])";
export type Tier = typeof tiers[number];
export type ModelSource = "explicit" | "tier" | "inherited";
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
export interface ModelProfile { model: string; thinking?: ModelThinkingLevel | null }
export type ModelEntry = string | ModelProfile;
export interface Config { defaultTier?: Tier; models?: Partial<Record<Tier, ModelEntry>> }
export interface ModelRequest { tier?: Tier; model?: string }
export interface ModelSelection { model: string; tier?: Tier; modelSource: ModelSource }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTier(value: unknown): value is Tier {
  return typeof value === "string" && tiers.includes(value as Tier);
}
export function splitModelId(value: string): { provider: string; id: string } {
  if (typeof value !== "string" || !new RegExp(modelIdPattern).test(value))
    throw new Error("Expected an exact provider/model-id (no whitespace); model IDs may contain additional slashes.");
  const separator = value.indexOf("/");
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}
function validateModelEntry(value: unknown): void {
  if (typeof value === "string") { splitModelId(value); return; }
  if (!isObject(value) || Object.keys(value).some(key => key !== "model" && key !== "thinking"))
    throw new Error("Expected a provider/model-id string or an object with only model and optional thinking.");
  if (typeof value.model !== "string") throw new Error("model must be a provider/model-id string.");
  splitModelId(value.model);
  if ("thinking" in value && value.thinking !== null &&
      (typeof value.thinking !== "string" || !thinkingLevels.includes(value.thinking as ModelThinkingLevel)))
    throw new Error(`thinking must be null (off) or one of: ${thinkingLevels.join(", ")}. Omit it to inherit the principal.`);
}
function parseConfig(value: unknown): Config {
  if (!isObject(value) || Object.keys(value).some(key => key !== "models" && key !== "defaultTier"))
    throw new Error("Expected an object with only defaultTier and models.");
  if ("defaultTier" in value && !isTier(value.defaultTier)) throw new Error("defaultTier must be low, medium or high.");
  if ("models" in value) {
    if (!isObject(value.models)) throw new Error("models must be an object mapping tiers to model strings or model/thinking objects.");
    for (const [tier, entry] of Object.entries(value.models)) {
      if (!isTier(tier)) throw new Error(`Unknown model tier: ${tier}.`);
      try { validateModelEntry(entry); } catch (error) { throw new Error(`models.${tier}: ${(error as Error).message}`); }
    }
  }
  return value as Config;
}
async function readConfig(path: string): Promise<Config> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read subagent configuration ${path}: ${(error as Error).message}`);
  }
  try { return parseConfig(JSON.parse(source)); }
  catch (error) { throw new Error(`Invalid subagent configuration ${path}: ${(error as Error).message}`); }
}
/** Read on each spawn; never create configuration files or silently ignore invalid ones. */
export async function loadConfig(cwd: string, agentDir: string): Promise<Config> {
  const [global, project] = await Promise.all([
    readConfig(join(agentDir, "herdr-subagents.json")),
    readConfig(join(cwd, ".pi", "herdr-subagents.json"))
  ]);
  return { defaultTier: project.defaultTier ?? global.defaultTier ?? "medium", models: { ...global.models, ...project.models } };
}
export function selectModel(config: Config, request: ModelRequest, inherited?: string): ModelSelection {
  if (request.model !== undefined && request.tier !== undefined) throw new Error("model and tier are mutually exclusive.");
  if (request.model !== undefined) {
    splitModelId(request.model);
    return { model: request.model, modelSource: "explicit" };
  }
  const tier = request.tier ?? config.defaultTier ?? "medium";
  if (!isTier(tier)) throw new Error("tier must be low, medium or high.");
  const entry = config.models?.[tier];
  if (entry !== undefined) {
    validateModelEntry(entry);
    const model = typeof entry === "string" ? entry : entry.model;
    return { model, tier, modelSource: "tier" };
  }
  if (Object.keys(config.models ?? {}).length)
    throw new Error(`No model configured for tier "${tier}". Configure models.${tier} in herdr-subagents.json or select a configured tier; no automatic fallback.`);
  if (!inherited) throw new Error("Select a principal model or configure a subagent model before delegation.");
  splitModelId(inherited);
  return { model: inherited, tier, modelSource: "inherited" };
}
/** Resolve the requested startup level, not the model/provider's effective level. */
export function selectThinking(config: Config, selection: ModelSelection, inherited: ModelThinkingLevel = "off"): ModelThinkingLevel {
  const entry = selection.modelSource === "tier" && selection.tier ? config.models?.[selection.tier] : undefined;
  if (entry === undefined || typeof entry === "string" || entry.thinking === undefined) return inherited;
  // null is an explicit opt-out, NOT inheritance. Omission alone inherits.
  return entry.thinking === null ? "off" : entry.thinking;
}
