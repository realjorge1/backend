/**
 * Response-shape snapshots for backward-compatibility checks.
 *
 * shapeOf() reduces a JSON body to a map of key -> type name, recursing into
 * objects and the first element of arrays. assertCompatible() then checks that
 * every key present in the baseline is still present with a compatible type.
 * Keys that only exist in the new response are allowed — the contract is
 * additive.
 */

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function shapeOf(value) {
  const t = typeName(value);
  if (t === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = shapeOf(value[key]);
    return out;
  }
  if (t === "array") {
    return value.length === 0 ? ["empty"] : [shapeOf(value[0])];
  }
  return t;
}

/**
 * A baseline type of "null" matches anything: a field that was null before may
 * legitimately carry data now (and vice versa) without breaking a client.
 */
function compatibleLeaf(baseline, current) {
  if (baseline === "null" || current === "null") return true;
  return baseline === current;
}

function assertCompatible(baseline, current, path, failures) {
  const bIsObj = baseline && typeof baseline === "object" && !Array.isArray(baseline);
  const cIsObj = current && typeof current === "object" && !Array.isArray(current);

  if (bIsObj) {
    if (!cIsObj) {
      failures.push(`${path}: was an object, now ${JSON.stringify(current)}`);
      return;
    }
    for (const key of Object.keys(baseline)) {
      if (!(key in current)) {
        failures.push(`${path}.${key}: key was removed`);
        continue;
      }
      assertCompatible(baseline[key], current[key], `${path}.${key}`, failures);
    }
    return;
  }

  if (Array.isArray(baseline)) {
    if (!Array.isArray(current)) {
      failures.push(`${path}: was an array, now ${JSON.stringify(current)}`);
      return;
    }
    // An empty baseline array tells us nothing about element shape.
    if (baseline[0] === "empty" || current[0] === "empty") return;
    assertCompatible(baseline[0], current[0], `${path}[0]`, failures);
    return;
  }

  if (!compatibleLeaf(baseline, current)) {
    failures.push(`${path}: type changed ${baseline} -> ${current}`);
  }
}

/**
 * Throws if `current` drops or retypes anything recorded in `baseline`.
 */
function checkCompatible(name, baseline, current) {
  const failures = [];
  assertCompatible(baseline, current, name, failures);
  if (failures.length > 0) {
    throw new Error(
      `Backward-compatibility break in ${name}:\n  ` + failures.join("\n  "),
    );
  }
}

module.exports = { shapeOf, checkCompatible };
