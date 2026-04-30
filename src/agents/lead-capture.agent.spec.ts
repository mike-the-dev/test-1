import { LeadCaptureAgent } from "./lead-capture.agent";

describe("LeadCaptureAgent", () => {
  let agent: LeadCaptureAgent;

  beforeEach(() => {
    agent = new LeadCaptureAgent();
  });

  it("has the correct name", () => {
    expect(agent.name).toBe("lead_capture");
  });

  it("has the correct displayName", () => {
    expect(agent.displayName).toBe("Lead Capture Assistant");
  });

  it("has a non-empty description", () => {
    expect(typeof agent.description).toBe("string");
    expect(agent.description.length).toBeGreaterThan(0);
  });

  it("includes request_verification_code and verify_code in allowedToolNames", () => {
    expect(agent.allowedToolNames).toContain("request_verification_code");
    expect(agent.allowedToolNames).toContain("verify_code");
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
