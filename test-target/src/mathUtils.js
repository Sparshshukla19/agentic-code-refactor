// Untyped helper file, imported by userController.js — a good candidate
// for bottom-up refactoring (utilities before consumers).

function add(a, b) {
  return a + b;
}

function average(numbers) {
  var total = 0;
  for (var i = 0; i < numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

module.exports = { add, average, clamp };
