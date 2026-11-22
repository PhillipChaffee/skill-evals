const { add } = require("../src/add.js");

module.exports = [
  ["adds two positive numbers", () => add(1, 2) === 3],
  ["adds zero", () => add(5, 0) === 5],
  ["adds a negative number", () => add(2, -3) === -1],
];
