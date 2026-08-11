export type LosslessJsonValue =
  | string
  | number
  | boolean
  | null
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

export function cloneLosslessJson(
  value: unknown,
  field: string,
  ancestors: Set<object> = new Set(),
): LosslessJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`${field} contains a non-lossless JSON number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${field} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw new Error(`${field} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const propertyNames = Object.getOwnPropertyNames(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        propertyNames.length !== keys.length + 1 ||
        propertyNames.some((key) => key !== "length" && !keys.includes(key))
      ) {
        throw new Error(`${field} contains a sparse or extended array`);
      }
      return value.map((item, index) =>
        cloneLosslessJson(item, `${field}[${index}]`, ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${field} contains a non-semantic JSON object`);
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new Error(`${field} contains non-JSON object properties`);
    }
    const result: Record<string, LosslessJsonValue> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error(`${field} contains an accessor or custom serialization`);
      }
      result[key] = cloneLosslessJson(
        descriptor.value,
        `${field}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function cloneLosslessJsonObject(
  value: unknown,
  field: string,
): Record<string, LosslessJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a non-null, non-array JSON object`);
  }
  const cloned = cloneLosslessJson(value, field);
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new Error(`${field} must remain a JSON object`);
  }
  return cloned;
}
