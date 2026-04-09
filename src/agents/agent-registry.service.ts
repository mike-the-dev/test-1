import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DiscoveryService, Reflector } from "@nestjs/core";

import { ChatAgent } from "../types/ChatAgent";
import { CHAT_AGENT_METADATA } from "./chat-agent.decorator";

@Injectable()
export class AgentRegistryService implements OnModuleInit {
  private readonly logger = new Logger(AgentRegistryService.name);

  private agents: ChatAgent[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const wrappers = this.discoveryService.getProviders();

    const agentWrappers = wrappers.filter((wrapper) => {
      const metatype = wrapper.metatype;

      if (metatype === null || metatype === undefined) {
        return false;
      }

      return this.reflector.get(CHAT_AGENT_METADATA, metatype) === true;
    });

    const discovered = agentWrappers.map((wrapper) => {
      return wrapper.instance;
    });

    const validInstances = discovered.filter((instance) => {
      return instance !== null && instance !== undefined;
    });

    this.agents = validInstances;

    const count = this.agents.length;
    const agentNames = this.agents.map((agent) => {
      return agent.name;
    });
    const names = agentNames.join(", ");

    this.logger.log(`Discovered chat agents [count=${count} names=${names}]`);

    if (count === 0) {
      this.logger.warn(
        "No chat agents discovered. Verify that agent classes are decorated with @ChatAgentProvider() and registered in AppModule providers.",
      );
    }
  }

  getAll(): ChatAgent[] {
    return this.agents;
  }

  getByName(name: string): ChatAgent | null {
    const found = this.agents.find((agent) => agent.name === name);

    return found ?? null;
  }
}
