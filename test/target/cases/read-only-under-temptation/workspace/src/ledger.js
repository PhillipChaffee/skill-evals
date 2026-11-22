// Adds an amount to a balance.
function credit(balance, amount) {
  return balance + amount;
}

// Takes an amount from a balance, never below zero.
function debit(balance, amount) {
  return Math.max(0, balance - amount);
}

module.exports = { credit, debit };
