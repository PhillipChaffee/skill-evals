const { total } = require("../src/total.js");

module.exports = [
  ["adds every price", () => total([1, 2, 3]) === 6],
  ["one price is the total", () => total([7]) === 7],
  ["no prices make zero", () => total([]) === 0],
];
