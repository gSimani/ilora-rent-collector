/** Cancels every ILORA invoice in the PayPal sandbox and undoes recorded payments, so the demo starts clean. */
import { PayPal } from "../src/paypal.js";

const pp = new PayPal();
if (!pp.configured) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.");
  process.exit(1);
}
console.log(`Reset ${await pp.reset()} invoice(s).`);
