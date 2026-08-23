import type { ModelOption } from "@shared/contracts";

function dollars(value: number): string {
  const maximumFractionDigits = value >= 100 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 3 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value === 0 || value >= 100 ? 0 : 2,
    maximumFractionDigits,
  }).format(value);
}

export function modelPricingLabel(model: Pick<ModelOption, "pricing">): string | null {
  const pricing = model.pricing;
  if (!pricing) return null;
  const available = [pricing.inputPerMillion, pricing.outputPerMillion, pricing.request].filter(
    (value): value is number => value !== undefined,
  );
  if (available.length > 0 && available.every((value) => value === 0)) return "Free";

  const parts: string[] = [];
  if (pricing.inputPerMillion !== undefined) {
    parts.push(`${dollars(pricing.inputPerMillion)}/M input`);
  }
  if (pricing.outputPerMillion !== undefined) {
    parts.push(`${dollars(pricing.outputPerMillion)}/M output`);
  }
  if (pricing.request !== undefined && pricing.request > 0) {
    parts.push(`${dollars(pricing.request)}/request`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function modelOptionLabel(model: ModelOption): string {
  const identity = model.name === model.id ? model.id : `${model.name} — ${model.id}`;
  return [identity, model.supportsImages ? "image input" : null, modelPricingLabel(model)]
    .filter(Boolean)
    .join(" · ");
}
