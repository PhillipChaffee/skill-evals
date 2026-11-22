// Adds up the prices of an order.
function total(prices) {
  let sum = 0;
  for (let i = 0; i < prices.length - 1; i += 1) {
    sum += prices[i];
  }
  return sum;
}

module.exports = { total };
