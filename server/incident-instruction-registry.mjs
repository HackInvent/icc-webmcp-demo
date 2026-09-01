export const INCIDENT_INSTRUCTION_SCHEMA_VERSION = "paris-icc-agent-instructions.v1";

export const INCIDENT_INSTRUCTION_TYPES = Object.freeze([
  "infrastructure",
  "passenger",
  "rolling-stock",
  "staff",
  "power",
  "works",
  "external",
  "communications",
  "security",
]);

const TYPE_SET = new Set(INCIDENT_INSTRUCTION_TYPES);
const CONFIGURED_KEYS = new Set(["type", "label", "instruction"]);
const TRANSFER_KEYS = new Set(["type", "instruction"]);

export class IncidentInstructionValidationError extends Error {
  constructor(path, message) {
    super(message);
    this.name = "IncidentInstructionValidationError";
    this.path = path;
  }
}

function invalid(path, message) {
  throw new IncidentInstructionValidationError(path, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedText(value, path, minimum, maximum) {
  if (typeof value !== "string") invalid(path, "must be a string");
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    invalid(path, `must contain between ${minimum} and ${maximum} characters after trimming`);
  }
  return normalized;
}

function completeInstructionSet(value, { configured, path }) {
  if (!Array.isArray(value) || value.length !== INCIDENT_INSTRUCTION_TYPES.length) {
    invalid(path, `must contain exactly ${INCIDENT_INSTRUCTION_TYPES.length} incident types`);
  }
  const expectedKeys = configured ? CONFIGURED_KEYS : TRANSFER_KEYS;
  const byType = new Map();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!exactKeys(raw, expectedKeys)) {
      invalid(itemPath, `must contain exactly ${[...expectedKeys].join(", ")}`);
    }
    const type = boundedText(raw.type, `${itemPath}.type`, 1, 40);
    if (!TYPE_SET.has(type)) invalid(`${itemPath}.type`, "is not a supported incident type");
    if (byType.has(type)) invalid(`${itemPath}.type`, "must be unique");
    byType.set(type, {
      type,
      ...(configured ? { label: boundedText(raw.label, `${itemPath}.label`, 1, 80) } : {}),
      instruction: boundedText(raw.instruction, `${itemPath}.instruction`, 40, 6_000),
    });
  });
  for (const type of INCIDENT_INSTRUCTION_TYPES) {
    if (!byType.has(type)) invalid(path, `is missing the ${type} incident type`);
  }
  return INCIDENT_INSTRUCTION_TYPES.map((type) => byType.get(type));
}

export function parseConfiguredIncidentInstructions(value, path = "agent.incidentInstructions") {
  return completeInstructionSet(value, { configured: true, path });
}

export function parseIncidentInstructionTransfer(value) {
  if (!plainObject(value) || !exactKeys(value, new Set(["schemaVersion", "instructions"]))) {
    invalid("configuration", "must contain exactly schemaVersion and instructions");
  }
  if (value.schemaVersion !== INCIDENT_INSTRUCTION_SCHEMA_VERSION) {
    invalid("configuration.schemaVersion", `must equal ${INCIDENT_INSTRUCTION_SCHEMA_VERSION}`);
  }
  return completeInstructionSet(value.instructions, {
    configured: false,
    path: "configuration.instructions",
  });
}

export function parseIncidentInstructionOverrides(value) {
  if (!Array.isArray(value) || value.length > INCIDENT_INSTRUCTION_TYPES.length) {
    invalid("agentRuntime.incidentInstructionOverrides", `must contain at most ${INCIDENT_INSTRUCTION_TYPES.length} entries`);
  }
  const byType = new Map();
  value.forEach((raw, index) => {
    const itemPath = `agentRuntime.incidentInstructionOverrides[${index}]`;
    if (!exactKeys(raw, TRANSFER_KEYS)) {
      invalid(itemPath, "must contain exactly type and instruction");
    }
    const type = boundedText(raw.type, `${itemPath}.type`, 1, 40);
    if (!TYPE_SET.has(type)) invalid(`${itemPath}.type`, "is not a supported incident type");
    if (byType.has(type)) invalid(`${itemPath}.type`, "must be unique");
    byType.set(type, {
      type,
      instruction: boundedText(raw.instruction, `${itemPath}.instruction`, 40, 6_000),
    });
  });
  return INCIDENT_INSTRUCTION_TYPES
    .filter((type) => byType.has(type))
    .map((type) => byType.get(type));
}

export function incidentInstructionTransfer(instructions) {
  return {
    schemaVersion: INCIDENT_INSTRUCTION_SCHEMA_VERSION,
    instructions: instructions.map(({ type, instruction }) => ({ type, instruction })),
  };
}
