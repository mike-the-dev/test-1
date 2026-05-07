import { buildOnboardingSchema } from "./buildOnboardingSchema";
import { SplashConfigOnboardingField } from "../types/SplashConfig";

describe("buildOnboardingSchema", () => {
  describe("budget field", () => {
    const budgetFieldRequired = {
      kind: "budget",
      key: "budgetCents",
      label: "What's your approximate budget?",
      required: true,
    } satisfies SplashConfigOnboardingField;

    const budgetFieldOptional = {
      kind: "budget",
      key: "budgetCents",
      label: "What's your approximate budget?",
      required: false,
    } satisfies SplashConfigOnboardingField;

    it("accepts a valid budget value", () => {
      const schema = buildOnboardingSchema([budgetFieldRequired]);
      expect(schema.safeParse({ budgetCents: 50_000 }).success).toBe(true);
    });

    it("rejects a non-integer budget value", () => {
      const schema = buildOnboardingSchema([budgetFieldRequired]);
      expect(schema.safeParse({ budgetCents: 50_000.5 }).success).toBe(false);
    });

    it("rejects zero for a required budget field", () => {
      const schema = buildOnboardingSchema([budgetFieldRequired]);
      expect(schema.safeParse({ budgetCents: 0 }).success).toBe(false);
    });

    it("rejects a budget over the cap (100_000_001)", () => {
      const schema = buildOnboardingSchema([budgetFieldRequired]);
      expect(schema.safeParse({ budgetCents: 100_000_001 }).success).toBe(false);
    });

    it("makes budget optional when required: false", () => {
      const schema = buildOnboardingSchema([budgetFieldOptional]);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ budgetCents: 75_000 }).success).toBe(true);
    });
  });

  describe("industry field", () => {
    const industryFieldRequired = {
      kind: "industry",
      key: "industry",
      label: "What industry are you in?",
      options: ["healthcare", "retail", "technology"],
      required: true,
    } satisfies SplashConfigOnboardingField;

    const industryFieldOptional = {
      kind: "industry",
      key: "industry",
      label: "What industry are you in?",
      options: ["healthcare", "retail", "technology"],
      required: false,
    } satisfies SplashConfigOnboardingField;

    it("accepts a valid industry selection", () => {
      const schema = buildOnboardingSchema([industryFieldRequired]);
      expect(schema.safeParse({ industry: "healthcare" }).success).toBe(true);
    });

    it("rejects an industry value not in options", () => {
      const schema = buildOnboardingSchema([industryFieldRequired]);
      expect(schema.safeParse({ industry: "agriculture" }).success).toBe(false);
    });

    it("makes industry optional when required: false", () => {
      const schema = buildOnboardingSchema([industryFieldOptional]);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ industry: "retail" }).success).toBe(true);
    });
  });

  describe("shortText field", () => {
    const shortTextFieldRequired = {
      kind: "shortText",
      key: "companyName",
      label: "What is your company name?",
      required: true,
      maxLength: 100,
    } satisfies SplashConfigOnboardingField;

    const shortTextFieldOptional = {
      kind: "shortText",
      key: "companyName",
      label: "What is your company name?",
      required: false,
      maxLength: 100,
    } satisfies SplashConfigOnboardingField;

    it("accepts a valid shortText value within maxLength", () => {
      const schema = buildOnboardingSchema([shortTextFieldRequired]);
      expect(schema.safeParse({ companyName: "Acme Corp" }).success).toBe(true);
    });

    it("rejects a shortText value exceeding maxLength", () => {
      const schema = buildOnboardingSchema([shortTextFieldRequired]);
      const tooLong = "x".repeat(101);
      expect(schema.safeParse({ companyName: tooLong }).success).toBe(false);
    });

    it("makes shortText optional when required: false", () => {
      const schema = buildOnboardingSchema([shortTextFieldOptional]);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ companyName: "Acme Corp" }).success).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns an empty object schema for an empty fields array", () => {
      const schema = buildOnboardingSchema([]);
      expect(schema.safeParse({}).success).toBe(true);
    });

    it("throws when industry field has an empty options array", () => {
      const fieldWithNoOptions = {
        kind: "industry",
        key: "industry",
        label: "Industry",
        options: [],
        required: true,
      } satisfies SplashConfigOnboardingField;

      expect(() => buildOnboardingSchema([fieldWithNoOptions])).toThrow(
        "OnboardingField 'industry' must have at least one option",
      );
    });
  });
});
