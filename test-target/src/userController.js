// Consumes mathUtils.js — used to verify multi-file refactor sync:
// mathUtils must be refactored before userController per the DAG.

var mathUtils = require("./mathUtils");

function getUserScoreSummary(scores) {
  var avg = mathUtils.average(scores);
  var clamped = mathUtils.clamp(avg, 0, 100);
  return {
    average: avg,
    clamped: clamped,
    total: scores.reduce(function (sum, s) {
      return mathUtils.add(sum, s);
    }, 0),
  };
}

module.exports = { getUserScoreSummary };
