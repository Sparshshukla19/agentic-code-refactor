// Legacy untyped file with nested callback hell — a target for refactoring.

function fetchUserData(userId, callback) {
  getUserFromDb(userId, function (err, user) {
    if (err) {
      callback(err);
    } else {
      getOrdersForUser(user.id, function (err2, orders) {
        if (err2) {
          callback(err2);
        } else {
          getPaymentsForOrders(orders, function (err3, payments) {
            if (err3) {
              callback(err3);
            } else {
              callback(null, { user, orders, payments });
            }
          });
        }
      });
    }
  });
}

function getUserFromDb(userId, cb) {
  setTimeout(() => cb(null, { id: userId, name: "Sample User" }), 10);
}

function getOrdersForUser(userId, cb) {
  setTimeout(() => cb(null, [{ id: 1, userId }]), 10);
}

function getPaymentsForOrders(orders, cb) {
  setTimeout(() => cb(null, orders.map((o) => ({ orderId: o.id, amount: 42 }))), 10);
}

module.exports = { fetchUserData };
