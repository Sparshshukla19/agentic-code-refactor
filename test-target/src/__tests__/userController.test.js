const { getUserScoreSummary } = require("../userController");

test("computes average, clamped value, and total for a set of scores", () => {
  const result = getUserScoreSummary([80, 90, 70]);
  expect(result.average).toBeCloseTo(80);
  expect(result.clamped).toBeCloseTo(80);
  expect(result.total).toBe(240);
});

test("clamps average above 100 down to 100", () => {
  const result = getUserScoreSummary([150, 200]);
  expect(result.clamped).toBe(100);
});
