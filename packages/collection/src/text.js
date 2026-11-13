// The text rules the contracts enforce, so the pipeline rejects a config before a transaction would.

/** Letters, digits, space and ' , - . : _ (ChampionCollection._checkName: token names and epithets). */
const NAME_RE = /^[0-9A-Za-z ',\-.:_]*$/;

/** Printable ASCII without '"' and '\' (ChampionMetadata._checkJson: labels, tagline, URLs). */
const JSON_RE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

/**
 * @param {string} what  where the text comes from, for the error
 * @param {unknown} s
 * @param {number} min
 * @param {number} max
 * @returns {string}
 */
export function checkName(what, s, min, max) {
  if (typeof s !== 'string') throw new Error(`${what}: expected a string`);
  if (s.length < min || s.length > max) throw new Error(`${what}: "${s}" must be ${min}-${max} characters`);
  if (!NAME_RE.test(s)) throw new Error(`${what}: "${s}" may only use letters, digits, space and ' , - . : _`);
  return s;
}

/**
 * @param {string} what
 * @param {unknown} s
 * @param {number} min
 * @param {number} max
 * @returns {string}
 */
export function checkJsonText(what, s, min, max) {
  if (typeof s !== 'string') throw new Error(`${what}: expected a string`);
  if (s.length < min || s.length > max) throw new Error(`${what}: must be ${min}-${max} characters`);
  if (!JSON_RE.test(s)) throw new Error(`${what}: "${s}" must be printable ASCII without " or \\`);
  return s;
}
