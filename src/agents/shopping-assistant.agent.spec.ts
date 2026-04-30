import { ShoppingAssistantAgent } from "./shopping-assistant.agent";

describe("ShoppingAssistantAgent", () => {
  let agent: ShoppingAssistantAgent;

  beforeEach(() => {
    agent = new ShoppingAssistantAgent();
  });

  it("has the correct name", () => {
    expect(agent.name).toBe("shopping_assistant");
  });

  it("has the correct displayName", () => {
    expect(agent.displayName).toBe("Shopping Assistant");
  });

  it("has a non-empty description", () => {
    expect(typeof agent.description).toBe("string");
    expect(agent.description.length).toBeGreaterThan(0);
  });

  it("has the expected allowed tool names including request_verification_code and verify_code", () => {
    expect(agent.allowedToolNames).toEqual([
      "list_services",
      "collect_contact_info",
      "preview_cart",
      "generate_checkout_link",
      "lookup_knowledge_base",
      "request_verification_code",
      "verify_code",
    ]);
    expect(agent.allowedToolNames).toHaveLength(7);
    expect(agent.allowedToolNames).toContain("preview_cart");
    expect(agent.allowedToolNames).toContain("generate_checkout_link");
    expect(agent.allowedToolNames).toContain("lookup_knowledge_base");
    expect(agent.allowedToolNames).toContain("request_verification_code");
    expect(agent.allowedToolNames).toContain("verify_code");
  });

  it("does not include save_user_fact in allowedToolNames", () => {
    expect(agent.allowedToolNames).not.toContain("save_user_fact");
  });

  it("does not include send_email in allowedToolNames", () => {
    expect(agent.allowedToolNames).not.toContain("send_email");
  });

  it("has a non-empty systemPrompt", () => {
    expect(typeof agent.systemPrompt).toBe("string");
    expect(agent.systemPrompt.length).toBeGreaterThan(0);
  });

  it("systemPrompt includes the RETURNING VISITOR FLOW section", () => {
    expect(agent.systemPrompt).toContain("RETURNING VISITOR FLOW");
  });

  it("systemPrompt RETURNING VISITOR FLOW section covers verification success path", () => {
    expect(agent.systemPrompt).toContain("verified: true");
  });

  it("systemPrompt RETURNING VISITOR FLOW section covers graceful failure path", () => {
    expect(agent.systemPrompt).toContain("No worries");
  });
});
