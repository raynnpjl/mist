import "./env.js";
import { Accounts } from "./accounts.js";

async function main() {
  const [command, value, ...extra] = process.argv.slice(2);
  if (extra.length || !["init", "create", "list", "revoke"].includes(command) ||
    (command === "revoke" ? !value : value !== undefined)) {
    throw new Error("Usage: npm run access-key -- init | create | list | revoke <account-id>");
  }
  const accounts = await Accounts.open();
  if (command === "init") { await accounts.initialize(); console.log("Neon account table initialized."); }
  if (command === "create") console.log(JSON.stringify(await accounts.createAccessKey(), null, 2));
  if (command === "list") console.log(JSON.stringify(await accounts.listAccessKeys(), null, 2));
  if (command === "revoke") {
    if (!await accounts.revokeAccessKey(value)) throw new Error("Account not found or already revoked");
    console.log("Account revoked. Its key, browser sessions and addon endpoints are now disabled.");
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
