import { Test, TestingModule } from "@nestjs/testing";
import { DiscoveryService, Reflector } from "@nestjs/core";

import { ToolRegistryService } from "./tool-registry.service";
import { CHAT_TOOL_METADATA } from "./chat-tool.decorator";

const TEST_CONTEXT = { sessionUlid: "01TESTSESSION0000000000000" };

const makeMockTool = (name: string) => {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: jest.fn().mockResolvedValue({ result: `${name} executed` }),
  };
};

class FakeMetatype {}

const makeDiscoveryMock = (tools: ReturnType<typeof makeMockTool>[]) => {
  const wrappers = tools.map((tool) => {
    return { metatype: FakeMetatype, instance: tool };
  });

  return { getProviders: jest.fn().mockReturnValue(wrappers) };
};

const makeReflectorMock = (returnValue: boolean | undefined) => {
  return {
    get: jest.fn((key: string, target: Function) => {
      if (key === CHAT_TOOL_METADATA && target === FakeMetatype) {
        return returnValue;
      }

      return undefined;
    }),
  };
};

const buildRegistry = async (
  discoveryMock: ReturnType<typeof makeDiscoveryMock>,
  reflectorMock: ReturnType<typeof makeReflectorMock>,
): Promise<ToolRegistryService> => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ToolRegistryService,
      { provide: DiscoveryService, useValue: discoveryMock },
      { provide: Reflector, useValue: reflectorMock },
    ],
  }).compile();

  return module.get<ToolRegistryService>(ToolRegistryService);
};

describe("ToolRegistryService", () => {
  let registry: ToolRegistryService;
  let mockTool: ReturnType<typeof makeMockTool>;

  beforeEach(async () => {
    mockTool = makeMockTool("test_tool");

    registry = await buildRegistry(makeDiscoveryMock([mockTool]), makeReflectorMock(true));

    registry.onModuleInit();
  });

  describe("getAll", () => {
    it("returns all registered tools", () => {
      const tools = registry.getAll();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("test_tool");
    });
  });

  describe("getDefinitions", () => {
    it("maps each tool to a definition with name, description, and input_schema", () => {
      const definitions = registry.getDefinitions();

      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toEqual({
        name: "test_tool",
        description: "Mock tool: test_tool",
        input_schema: { type: "object", properties: {}, required: [] },
      });
    });
  });

  describe("execute", () => {
    it("dispatches to the correct tool by name", async () => {
      const result = await registry.execute("test_tool", { key: "x" }, TEST_CONTEXT);

      expect(result.result).toBe("test_tool executed");
      expect(mockTool.execute).toHaveBeenCalledWith({ key: "x" }, TEST_CONTEXT);
    });

    it("returns an error result when tool name is not found", async () => {
      const result = await registry.execute("unknown_tool", {}, TEST_CONTEXT);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Tool not found");
    });

    it("does not throw when tool name is not found", async () => {
      await expect(registry.execute("unknown_tool", {}, TEST_CONTEXT)).resolves.not.toThrow();
    });

    it("returns an error result when the tool's execute method throws", async () => {
      mockTool.execute.mockRejectedValue(new Error("Unexpected tool crash"));

      const result = await registry.execute("test_tool", {}, TEST_CONTEXT);

      expect(result.isError).toBe(true);
      expect(result.result).toContain("Tool execution failed unexpectedly");
    });

    it("does not throw when the tool's execute method throws", async () => {
      mockTool.execute.mockRejectedValue(new Error("Unexpected tool crash"));

      await expect(registry.execute("test_tool", {}, TEST_CONTEXT)).resolves.not.toThrow();
    });

    it("selects the correct tool when multiple tools are registered", async () => {
      const firstTool = makeMockTool("first_tool");
      const secondTool = makeMockTool("second_tool");

      const registryWithTwo = await buildRegistry(
        makeDiscoveryMock([firstTool, secondTool]),
        makeReflectorMock(true),
      );

      registryWithTwo.onModuleInit();

      await registryWithTwo.execute("second_tool", {}, TEST_CONTEXT);

      expect(secondTool.execute).toHaveBeenCalledTimes(1);
      expect(firstTool.execute).not.toHaveBeenCalled();
    });
  });

  describe("onModuleInit", () => {
    it("logs a warning when no tools are discovered", async () => {
      const emptyRegistry = await buildRegistry(
        { getProviders: jest.fn().mockReturnValue([]) },
        makeReflectorMock(undefined),
      );

      const warnSpy = jest.spyOn(emptyRegistry["logger"], "warn");

      emptyRegistry.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        "No chat tools discovered. Verify that tool classes are decorated with @ChatToolProvider() and registered in AppModule providers.",
      );
    });
  });
});
