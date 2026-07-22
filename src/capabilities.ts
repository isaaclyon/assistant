import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface CapabilityResourceDefinition {
  id: string;
  path: string;
  enabled: boolean;
}

export interface CapabilityProfileDefinition {
  id: string;
  extensions: string[];
  skills: string[];
  instructions: string;
}

export interface CapabilityManifest {
  version: 1;
  resources: {
    extensions: CapabilityResourceDefinition[];
    skills: CapabilityResourceDefinition[];
    instructions: CapabilityResourceDefinition[];
  };
  profiles: CapabilityProfileDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} has unknown field "${unknown}"`);
}

function requireSlug(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`${field} must be a lowercase slug of at most 64 characters`);
  }
  return value;
}

function requireRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value)) {
    throw new Error(`${field} must be a relative path inside the release`);
  }
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${field} must not escape the release`);
  }
  return normalized;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const items = value.map((item, index) => requireSlug(item, `${field}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`${field} must not contain duplicate resource IDs`);
  }
  return items;
}

function parseResource(
  value: unknown,
  kind: string,
  index: number,
): CapabilityResourceDefinition {
  const label = `resources.${kind}[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownFields(value, ["id", "path", "enabled"], label);
  if (typeof value.enabled !== "boolean") {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  return {
    id: requireSlug(value.id, `${label}.id`),
    path: requireRelativePath(value.path, `${label}.path`),
    enabled: value.enabled,
  };
}

function parseResourceList(value: unknown, kind: string): CapabilityResourceDefinition[] {
  if (!Array.isArray(value)) throw new Error(`resources.${kind} must be an array`);
  const resources = value.map((item, index) => parseResource(item, kind, index));
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource.id)) {
      throw new Error(`Duplicate ${kind} capability resource ID: "${resource.id}"`);
    }
    seen.add(resource.id);
  }
  return resources;
}

function parseProfile(value: unknown, index: number): CapabilityProfileDefinition {
  const label = `profiles[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownFields(
    value,
    ["id", "extensions", "skills", "instructions"],
    label,
  );
  return {
    id: requireSlug(value.id, `${label}.id`),
    extensions: requireStringArray(value.extensions, `${label}.extensions`),
    skills: requireStringArray(value.skills, `${label}.skills`),
    instructions: requireSlug(value.instructions, `${label}.instructions`),
  };
}

export function parseCapabilityManifest(raw: string): CapabilityManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Capability manifest is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.resources)) {
    throw new Error("Capability manifest must declare version 1 and resources");
  }
  rejectUnknownFields(value, ["version", "resources", "profiles"], "Capability manifest");
  rejectUnknownFields(
    value.resources,
    ["extensions", "skills", "instructions"],
    "Capability resources",
  );
  if (!Array.isArray(value.profiles)) {
    throw new Error("Capability manifest profiles must be an array");
  }
  const manifest: CapabilityManifest = {
    version: 1,
    resources: {
      extensions: parseResourceList(value.resources.extensions, "extensions"),
      skills: parseResourceList(value.resources.skills, "skills"),
      instructions: parseResourceList(value.resources.instructions, "instructions"),
    },
    profiles: value.profiles.map(parseProfile),
  };
  const seenProfiles = new Set<string>();
  for (const profile of manifest.profiles) {
    if (seenProfiles.has(profile.id)) {
      throw new Error(`Duplicate capability profile ID: "${profile.id}"`);
    }
    seenProfiles.add(profile.id);

    const validateSelections = (
      selectedIds: readonly string[],
      resources: readonly CapabilityResourceDefinition[],
      kind: string,
    ): void => {
      const enabledIds = new Set(
        resources.filter((resource) => resource.enabled).map((resource) => resource.id),
      );
      for (const selectedId of selectedIds) {
        if (!enabledIds.has(selectedId)) {
          throw new Error(
            `Capability profile "${profile.id}" selects unknown or disabled ${kind} "${selectedId}"`,
          );
        }
      }
    };
    validateSelections(profile.extensions, manifest.resources.extensions, "extension");
    validateSelections(profile.skills, manifest.resources.skills, "skill");
    validateSelections(
      [profile.instructions],
      manifest.resources.instructions,
      "instructions",
    );
  }
  return manifest;
}

export function selectCapabilityProfile(
  manifest: CapabilityManifest,
  profileId: string,
): CapabilityProfileDefinition {
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown capability profile: ${profileId}`);
  return profile;
}

export interface ResolvedCapabilityProfile {
  profileId: string;
  extensionPaths: string[];
  skillPaths: string[];
  instructionsPath: string;
}

export async function loadCapabilityProfile(
  resourceRoot: string,
  profileId: string,
): Promise<ResolvedCapabilityProfile> {
  const canonicalRoot = await realpath(resourceRoot);
  const rootPrefix = `${canonicalRoot}${sep}`;
  const ensureInsideRoot = (target: string, label: string): void => {
    if (target !== canonicalRoot && !target.startsWith(rootPrefix)) {
      throw new Error(`${label} resolves outside the immutable release`);
    }
  };
  const manifestPath = await realpath(
    join(canonicalRoot, ".pi", "capabilities.json"),
  );
  ensureInsideRoot(manifestPath, "Capability manifest");
  const manifest = parseCapabilityManifest(await readFile(manifestPath, "utf8"));
  const profile = selectCapabilityProfile(manifest, profileId);

  const resolveSelected = async (
    selectedId: string,
    resources: readonly CapabilityResourceDefinition[],
    kind: string,
  ): Promise<string> => {
    const resource = resources.find((candidate) => candidate.id === selectedId);
    if (!resource?.enabled) {
      throw new Error(
        `Capability profile "${profile.id}" selects unknown or disabled ${kind} "${selectedId}"`,
      );
    }
    const target = await realpath(resolve(canonicalRoot, resource.path));
    ensureInsideRoot(target, `Selected ${kind} "${resource.id}"`);
    return target;
  };

  return {
    profileId: profile.id,
    extensionPaths: await Promise.all(
      profile.extensions.map((id) =>
        resolveSelected(id, manifest.resources.extensions, "extension"),
      ),
    ),
    skillPaths: await Promise.all(
      profile.skills.map((id) =>
        resolveSelected(id, manifest.resources.skills, "skill"),
      ),
    ),
    instructionsPath: await resolveSelected(
      profile.instructions,
      manifest.resources.instructions,
      "instructions",
    ),
  };
}
