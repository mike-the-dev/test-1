import { Logger } from "@nestjs/common";
import { QdrantClient } from "@qdrant/js-client-rest";

import { QdrantProvider } from "./qdrant.provider";
import { QdrantConfigService } from "../services/qdrant-config.service";

jest.mock("@qdrant/js-client-rest");

const MockQdrantClient = jest.mocked(QdrantClient);

const mockConfig: Pick<QdrantConfigService, "url" | "apiKey"> = {
  url: "http://localhost:6333",
  apiKey: undefined,
};

describe("QdrantProvider", () => {
  let getCollectionsMock: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    getCollectionsMock = jest.fn();
    MockQdrantClient.mockImplementation(() => {
      const instance = Object.create(MockQdrantClient.prototype);
      instance.getCollections = getCollectionsMock;
      return instance;
    });

    logSpy = jest.spyOn(Logger, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger, "warn").mockImplementation(() => undefined);
  });

  describe("on successful getCollections()", () => {
    beforeEach(() => {
      getCollectionsMock.mockResolvedValue({ collections: [] });
    });

    it("returns the QdrantClient instance", async () => {
      const result = await QdrantProvider.useFactory(mockConfig);

      expect(result).toBeInstanceOf(MockQdrantClient);
    });

    it("logs a connected message with url and collectionCount", async () => {
      await QdrantProvider.useFactory(mockConfig);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Qdrant connected"),
        "QdrantProvider",
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(mockConfig.url),
        "QdrantProvider",
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("collectionCount=0"),
        "QdrantProvider",
      );
    });

    it("does not log a warning on success", async () => {
      await QdrantProvider.useFactory(mockConfig);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("when getCollections() rejects", () => {
    beforeEach(() => {
      getCollectionsMock.mockRejectedValue(new Error("connection refused"));
    });

    it("resolves without throwing", async () => {
      await expect(
        QdrantProvider.useFactory(mockConfig),
      ).resolves.toBeDefined();
    });

    it("returns the QdrantClient instance even on failure", async () => {
      const result = await QdrantProvider.useFactory(mockConfig);

      expect(result).toBeInstanceOf(MockQdrantClient);
    });

    it("logs an unreachable warning with url and error message", async () => {
      await QdrantProvider.useFactory(mockConfig);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Qdrant unreachable"),
        "QdrantProvider",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(mockConfig.url),
        "QdrantProvider",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("connection refused"),
        "QdrantProvider",
      );
    });

    it("does not log a connected message on failure", async () => {
      await QdrantProvider.useFactory(mockConfig);

      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("QdrantClient constructor options", () => {
    beforeEach(() => {
      getCollectionsMock.mockResolvedValue({ collections: [] });
    });

    it("constructs client with url only when apiKey is undefined", async () => {
      await QdrantProvider.useFactory(mockConfig);

      expect(MockQdrantClient).toHaveBeenCalledWith({ url: mockConfig.url });
    });

    it("constructs client with url and apiKey when apiKey is provided", async () => {
      const configWithKey: Pick<QdrantConfigService, "url" | "apiKey"> = {
        url: "http://localhost:6333",
        apiKey: "test-api-key",
      };

      await QdrantProvider.useFactory(configWithKey);

      expect(MockQdrantClient).toHaveBeenCalledWith({
        url: configWithKey.url,
        apiKey: configWithKey.apiKey,
      });
    });
  });
});
