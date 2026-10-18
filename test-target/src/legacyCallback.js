// Legacy untyped file with nested callback hell — a target for refactoring.

/**
 * @param {string|number} userId
 * @param {Function} callback
 * @returns {Promise<void>}
 */
async function fetchUserData(userId, callback) {
  let result;
  try {
    const user = await new Promise((resolve, reject) => {
      getUserFromDb(userId, function (err, data) {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const orders = await new Promise((resolve, reject) => {
      getOrdersForUser(user.id, function (err, data) {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const payments = await new Promise((resolve, reject) => {
      getPaymentsForOrders(orders, function (err, data) {
        if (err) reject(err);
        else resolve(data);
      });
    });
    result = { user, orders, payments };
  } catch (err) {
    callback(err);
    return;
  }
  callback(null, result);
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
