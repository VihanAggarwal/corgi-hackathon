import { getDuelBlock } from "@/components/data";
import { DuelScreen } from "@/components/duel/DuelScreen";

export const metadata = { title: "Duel — Taste Twins" };

export default async function DuelPage() {
  // The whole block is handed to the client at once, so no duel ever waits.
  const pairs = await getDuelBlock();
  return <DuelScreen pairs={pairs} />;
}
