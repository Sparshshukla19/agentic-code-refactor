// Untyped helper file, imported by userController.js — a good candidate
// for bottom-up refactoring (utilities before consumers).

function add(a, b) {
  return a + b;
}

/**
 * @param {number[]} numbers
 * @returns {number}
 */
function average(numbers) {
  let total = 0;
  for (let i = 0; i < numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

module.exports = { add, average, clamp };
