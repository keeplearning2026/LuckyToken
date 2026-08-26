import { InvalidRequest } from "../../failures.js";
import type { ReadonlyJsonObject, ReadonlyJsonValue } from "./contract.js";

function copyValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidRequest(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidRequest(`${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new InvalidRequest(`${path} must not contain a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new InvalidRequest(`${path} must contain only plain JSON arrays`);
      }
      const enumerableKeys = Object.keys(value);
      if (
        enumerableKeys.length !== value.length ||
        enumerableKeys.some((key, index) => key !== String(index)) ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        throw new InvalidRequest(`${path} must not contain a sparse or extended array`);
      }
      const copy: ReadonlyJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new InvalidRequest(`${path}[${index}] must be an enumerable data value`);
        }
        copy.push(copyValue(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return Object.freeze(copy);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new InvalidRequest(`${path} must contain only plain JSON objects`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new InvalidRequest(`${path} must not contain symbol keys`);
    }
    const copy: { [key: string]: ReadonlyJsonValue } = {};
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new InvalidRequest(`${path}.${key} must be an enumerable data value`);
      }
      Object.defineProperty(copy, key, {
        value: copyValue(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

export function immutableJsonObject(
  value: unknown,
  path: string,
): ReadonlyJsonObject {
  const copy = copyValue(value, path, new Set());
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
    throw new InvalidRequest(`${path} must be a JSON object`);
  }
  return copy as ReadonlyJsonObject;
}
