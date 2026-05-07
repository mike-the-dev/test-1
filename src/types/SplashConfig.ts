export interface SplashConfigOnboardingFieldBudget {
  kind: "budget";
  key: "budgetCents";
  label: string;
  required: boolean;
}

export interface SplashConfigOnboardingFieldIndustry {
  kind: "industry";
  key: "industry";
  label: string;
  options: string[];
  required: boolean;
}

export interface SplashConfigOnboardingFieldShortText {
  kind: "shortText";
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
}

export type SplashConfigOnboardingField =
  | SplashConfigOnboardingFieldBudget
  | SplashConfigOnboardingFieldIndustry
  | SplashConfigOnboardingFieldShortText;

export interface SplashConfig {
  fields: SplashConfigOnboardingField[];
}
