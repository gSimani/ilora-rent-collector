# Devpost text: ILORA.ai Rent Collector

## Name
ILORA.ai Rent Collector

## Tagline (200 characters max)
Finds rent a small property owner never billed, sends the tenant a PayPal invoice once the owner approves, and tracks what comes in. NVIDIA Nemotron picks the steps; tools count every dollar.

## About the project

### Inspiration
A lease says the rent goes up in March. Nobody changes the monthly charge in the accounting system, so the tenant keeps paying the old rate. Six months later, $9,000 is gone and nobody has noticed. Large firms pay staff to tie the lease, the rent roll and the ledger together every month. The owner of one strip center or one small apartment building does it alone, if at all, and then still has to write the bill and chase it.

There are 5.9 million commercial buildings in the U.S., and 71% of them are 10,000 square feet or smaller (EIA, CBECS 2018, Table B6). Those owners are the ones without staff for this.

### What it does
Press **Find rent to collect** and the Rent Collector reads two fictional properties and answers: $14,190 can be billed now. $9,000 to Harbor Light Pilates at Coral Wren Plaza for a March rent increase that was never billed, and $5,190 to the Jaramillo household at Tamarind Grove Apartments for two months with no rent posted. A $4,500 CAM reconciliation posted to the wrong account is a bookkeeping fix, so it is left out of the bills.

Then talk to it the way an owner would:

- **"Bill Harbor Light Pilates for the rent increase."** An approval card shows exactly what will be sent: the tenant, $9,000, the line item and the months. Nothing reaches PayPal until the owner clicks Approve. Then a real PayPal invoice goes out, with the reason in plain words, payable by PayPal, Venmo, Pay Later or card.
- **"Harbor Light Pilates paid by check."** Another approval card, then the PayPal invoice is marked paid.
- **"Who still owes me?"** Billed, collected and still due, read back from PayPal.

A running ledger on the right shows owed, billed and collected, with a link to each tenant's PayPal invoice. Answers are read aloud in an Amazon Polly generative voice. Sending the same bill twice returns the first invoice; a tenant is never billed twice.

All properties, tenants and figures are fictional, and PayPal runs in sandbox.

### How we built it
- **PayPal Invoicing v2 (sandbox).** OAuth client credentials, then create invoice, send, record payment, list and search. Each invoice carries the id of the check that found it in `detail.reference`, so PayPal itself is the record of what was billed and paid. The server keeps no state, nothing is lost on a cold start, and the "already sent" guard reads PayPal. The code refuses any PayPal host other than the sandbox.
- **Model Context Protocol server** (spec 2025-11-25, Streamable HTTP) with nine tools. Five check the documents (snapshot, rent roll against income statement, expiring leases, the lines behind a flag). Four handle collection: `draft_rent_invoices` and `rent_collection_status` are read-only; `send_rent_invoice` and `record_rent_payment` are annotated as writes.
- **Owner approval for every write.** The page is the MCP client. Before it runs any tool that is not read-only, it shows an approval card and waits. Cancel sends the model an "owner declined" result, and nothing reaches PayPal.
- **NVIDIA Nemotron 3 Nano on Nebius Token Factory** chooses which tool to call and writes the words. It never produces a number: every amount comes from a deterministic tool, and the tests assert each figure to the dollar.
- **AWS Lambda** serves the page, the MCP endpoint and the model route from one function URL; **Amazon Polly** speaks the answers.
- **Tests:** 64, including 17 new ones that run the PayPal tools against an in-memory copy of the Invoicing endpoints and a full bill-then-collect conversation.

### Challenges we ran into
Recording the demo caught the model doing exactly what this product must never do:
- Asked "Harbor Light Pilates paid by check.", Nemotron 3 Nano answered "Recorded payment for Harbor Light Pilates." with no tool call, three times out of three. After a plain correction it wrote the tool call out as text instead of making it. Now an answer that claims money was sent or recorded, with no write tool run since the owner spoke, gets one retry that names the tool the owner asked for; if it still claims without acting, the owner is told plainly that nothing was done. After the change: three of three real tool calls.
- With no amount mentioned, it once recorded a $1,000 payment the owner never said. A payment amount is now kept only if the owner said that figure; otherwise the full amount due is recorded and the approval card shows it.
- Asked what rent could be billed, it added a property filter the owner never asked for and hid one tenant. The collection tools now always cover the whole portfolio.

### Accomplishments that we're proud of
- The whole loop runs on real PayPal: find the money, bill it after approval, record the check, see who still owes.
- No dollar figure comes from the model, and no money moves without a click. Both are enforced in code, not just requested in a prompt.

### What we learned
- A model's "done" is a claim. The safe pattern is to check for the effect (a write tool actually ran) and refuse the claim otherwise.
- Making PayPal the system of record removed a whole class of state bugs: double billing, lost status after a restart, a ledger out of sync.

### What's next for ILORA.ai Rent Collector
Run the checks on an owner's real rent rolls, statements and leases through ILORA.ai's document pipeline; send recurring invoices for rent steps so the gap never opens again; and use PayPal webhooks so a tenant's payment updates the ledger the moment it lands.

## What is new during the submission period
This project builds on our ILORA.ai MCP server for property checks, written October 19 to 23, 2026, inside this hackathon's submission period. Added for this entry: the four PayPal invoicing tools, owner approval before every write, the no-double-billing reference, the collection ledger, and the guards against unbacked claims and invented amounts.

## Built with
paypal, paypal-invoicing, nvidia-nemotron, nebius-token-factory, model-context-protocol, typescript, node.js, express.js, zod, vite, aws-lambda, aws-sam, amazon-polly, vitest

## Links
- Try it: https://2m5wlrpse7djvpwbm7zwjjq2ei0osvhc.lambda-url.us-east-1.on.aws/
- Video: https://youtu.be/PWNbD-QoGq0
- Code: https://github.com/gSimani/ilora-rent-collector
