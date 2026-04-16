export interface ServiceVariantOption {
  option_id: string;
  value: string;
  price_usd: number;
  compare_price_usd: number | null;
}

export interface ServiceVariant {
  variant_id: string;
  name: string;
  options: ServiceVariantOption[];
}

export interface ServiceTrimmed {
  service_id: string;
  name: string;
  sub_title: string | null;
  description: string;
  price_usd: number;
  compare_price_usd: number | null;
  category: "default" | "instant";
  featured: boolean;
  ribbon_text: string | null;
  variants: ServiceVariant[];
  slug: string;
}
