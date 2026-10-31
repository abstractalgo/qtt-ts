// Correct usage: both checkers report nothing for this file.
import {
  cancelShipment,
  captureOrVoid,
  captureShipment,
  describeHold,
  openSession,
  voidAuthorization,
} from './payments.ts';

const session = openSession('merchant_42');
session.ping();

const shoes = session.authorize(120, 'EUR');
captureOrVoid(shoes, true);

const hat = session.authorize(35, 'EUR');
console.log(`holding ${describeHold(hat)}`);
captureOrVoid(hat, false);

const fraudulent = session.authorize(9_999, 'EUR');
if (fraudulent.amount > 5_000) {
  voidAuthorization(fraudulent);
} else {
  captureOrVoid(fraudulent, true);
}

// A container of authorizations is linear too: each part must be consumed.
const basket = [
  session.authorize(15, 'EUR'),
  session.authorize(25, 'EUR'),
] as const;
captureOrVoid(basket[0], true);
captureOrVoid(basket[1], false);

// An order in three shipments: SplitFunds<3>, inferred from the literal 3.
// Each shipment settles one use, so there must be exactly three settlements.
const order = session.authorizeSplit(90, 'EUR', 3);
captureShipment(order, 30);
captureShipment(order, 30);
cancelShipment(order, 30);

session.close();
