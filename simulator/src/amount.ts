/**
 * The model never produces a number. A payment amount is kept only if the owner
 * said that figure in their own message; otherwise it is dropped and the tool
 * records the full amount due, which the approval card then shows.
 */
export function ownersAmount(input: Record<string, unknown>, ownerText: string): Record<string, unknown> {
  if (input.amount === undefined) return input;
  const said = (ownerText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
  if (said.includes(Number(input.amount))) return input;
  const { amount: _dropped, ...rest } = input;
  return rest;
}
