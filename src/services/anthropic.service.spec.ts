import { Test, TestingModule } from "@nestjs/testing";

import { AnthropicService } from "./anthropic.service";
import { AnthropicConfigService } from "./anthropic-config.service";

const mockClient = {
  messages: {
    create: jest.fn(),
  },
};

jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockClient),
  };
});

const mockAnthropicConfig: Partial<AnthropicConfigService> = {
  apiKey: "sk-test",
  model: "claude-sonnet-4-6",
};

describe("AnthropicService", () => {
  let service: AnthropicService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnthropicService,
        { provide: AnthropicConfigService, useValue: mockAnthropicConfig },
      ],
    }).compile();

    service = module.get<AnthropicService>(AnthropicService);
  });

  it("passes only the cached static prefix when dynamicSystemContext is omitted", async () => {
    await service.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      "STATIC_PREFIX",
    );

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system).toEqual([
      { type: "text", text: "STATIC_PREFIX", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("appends an uncached second system block when dynamicSystemContext is provided", async () => {
    await service.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      "STATIC_PREFIX",
      "User context: budget = $1,000",
    );

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system).toEqual([
      { type: "text", text: "STATIC_PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "User context: budget = $1,000" },
    ]);
  });

  it("does not attach cache_control to the dynamic block", async () => {
    await service.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      "STATIC_PREFIX",
      "DYNAMIC",
    );

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system[1]).not.toHaveProperty("cache_control");
  });

  it("omits system when both systemPrompt and dynamicSystemContext are absent", async () => {
    await service.sendMessage([{ role: "user", content: [{ type: "text", text: "hi" }] }], []);

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system).toBeUndefined();
  });
});
