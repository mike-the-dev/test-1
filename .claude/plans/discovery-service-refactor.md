# Plan: DiscoveryService-Based Chat Tool Auto-Discovery

## Objective

Replace the `CHAT_TOOLS_TOKEN` factory provider with NestJS `DiscoveryService`-based auto-discovery so that registering a new chat tool requires only two steps: (1) decorate the tool class with `@ChatToolProvider()`, and (2) add it to the `providers` array in `app.module.ts`. The factory block, `CHAT_TOOLS_TOKEN` constant, and `@Inject(CHAT_TOOLS_TOKEN)` constructor injection are fully eliminated.

---

## Affected Files

**Create:**
- `src/tools/chat-tool.decorator.ts` — new marker decorator and metadata constant

**Modify:**
- `src/tools/save-user-fact.tool.ts` — apply `@ChatToolProvider()` decorator
- `src/tools/tool-registry.service.ts` — replace injection with discovery pattern
- `src/tools/tool-registry.service.spec.ts` — replace token-based test setup with DiscoveryService/Reflector mocks
- `src/app.module.ts` — add `DiscoveryModule` import, remove factory provider block and `CHAT_TOOLS_TOKEN` import

**Review only (no changes):**
- `src/types/Tool.ts` — `ChatTool` interface stays as-is; it is the type contract tools are verified against at runtime
- `.claude/instructions/style-enforcer.md` — style constraints govern implementation choices below

---

## Architectural Notes

### DiscoveryModule requirement
`DiscoveryService` is not globally available by default. `DiscoveryModule` from `@nestjs/core` must be imported in `AppModule.imports` or it will throw at runtime. This is the single most likely source of a silent startup failure if missed.

### No `as` casts — type guard pattern
The style rules prohibit `as` casts. When mapping `wrapper.instance` to `ChatTool`, the implementer must NOT write `wrapper.instance as ChatTool`. Instead, write a standalone narrowing helper function that checks whether an object has the required `ChatTool` properties (`name`, `description`, `inputSchema`, `execute`) using simple property access and truthy checks (not `in`, not `is`, not `typeof`). This is safe because the `@ChatToolProvider()` decorator is the contract — only correctly shaped tool instances will carry that metadata. The guard is a belt-and-suspenders null filter, not a full runtime validation. A simple check for `instance !== null && instance !== undefined` followed by truthy checks on `instance.name` and `instance.execute` is sufficient.

### `tools` field mutability
The current `tools` field is `readonly` via constructor injection (`private readonly tools: ChatTool[]`). After the refactor it must become a mutable private field (`private tools: ChatTool[] = []`) because it is populated during `onModuleInit`, not at construction time. Removing `readonly` here is intentional and correct.

### Decorator placement on `SaveUserFactTool`
`@ChatToolProvider()` must be placed **above** `@Injectable()` so NestJS metadata is applied in the correct decorator evaluation order (decorators evaluate bottom-up in TypeScript; the ChatTool marker needs to be on the outermost layer).

### `DiscoveryService.getProviders()` returns `InstanceWrapper[]`
Each wrapper has a `metatype` (the class constructor) and an `instance` (the live DI object). Both can be null in edge cases (e.g., async factories, non-class providers). Filtering for `wrapper.metatype !== undefined && wrapper.metatype !== null` before calling `this.reflector.get(...)` prevents a runtime crash.

---

## Step-by-Step Implementation Sequence

### Step 1 — Create `src/tools/chat-tool.decorator.ts`
**What:** Define and export the `CHAT_TOOL_METADATA` string constant and the `ChatToolProvider` factory function that calls `SetMetadata(CHAT_TOOL_METADATA, true)`.

**Why first:** Every downstream step depends on this constant being importable. The decorator and constant must exist before the service can reference them and before the tool can be decorated.

**Implementation details:**
- Import `SetMetadata` from `@nestjs/common`.
- Export `const CHAT_TOOL_METADATA = "chat_tool"`.
- Export `const ChatToolProvider = () => SetMetadata(CHAT_TOOL_METADATA, true)`.
- Add a JSDoc comment above `ChatToolProvider` explaining that any class decorated with it will be auto-discovered by `ToolRegistryService` during `onModuleInit`.
- File lives at `src/tools/chat-tool.decorator.ts` (consistent with NestJS decorator file naming in this codebase's `src/decorators/` convention, but since this is tool-specific it is co-located in `src/tools/`).

**Done when:** File compiles with `npx tsc --noEmit` and exports are importable from sibling files.

---

### Step 2 — Modify `src/tools/save-user-fact.tool.ts`
**What:** Apply `@ChatToolProvider()` above `@Injectable()`.

**Why here:** The tool must carry the metadata before `onModuleInit` runs discovery. This step is a prerequisite for step 3's discovery logic to find anything at all.

**Implementation details:**
- Add `import { ChatToolProvider } from "./chat-tool.decorator"` to the import block.
- Place `@ChatToolProvider()` on the line immediately above `@Injectable()`.
- No other changes to the file.

**Done when:** Class still implements `ChatTool`, file compiles, and `Reflector.get(CHAT_TOOL_METADATA, SaveUserFactTool)` would return `true` at runtime.

---

### Step 3 — Modify `src/tools/tool-registry.service.ts`
**What:** Rearchitect the service to use `DiscoveryService` + `Reflector` for tool population in `onModuleInit`. Remove `CHAT_TOOLS_TOKEN`.

**Why here:** This is the core of the refactor. It depends on step 1 (decorator constant) being importable. Steps 4 and 5 depend on `CHAT_TOOLS_TOKEN` being gone from this file.

**Implementation details:**

Imports to add:
- `OnModuleInit` from `@nestjs/common`
- `DiscoveryService, Reflector` from `@nestjs/core`
- `CHAT_TOOL_METADATA` from `./chat-tool.decorator`

Imports to remove:
- `Inject` from `@nestjs/common`

Constant to remove:
- `export const CHAT_TOOLS_TOKEN = "CHAT_TOOLS"` — delete entirely

Constructor change:
- Remove `@Inject(CHAT_TOOLS_TOKEN) private readonly tools: ChatTool[]`
- Add `private readonly discoveryService: DiscoveryService` and `private readonly reflector: Reflector` as constructor parameters

Field change:
- Add `private tools: ChatTool[] = []` as a class field (mutable, not readonly, initialized to empty array)

Interface:
- Class declaration: `implements OnModuleInit`

`onModuleInit()` method body (ordered steps with blank lines between each logical phase):

```
Phase 1 — Get all providers from DI container
  const wrappers = this.discoveryService.getProviders()

Phase 2 — Filter to wrappers that have a metatype (class-based providers only)
  const withMetatype = wrappers.filter((wrapper) => wrapper.metatype !== null && wrapper.metatype !== undefined)

Phase 3 — Filter to providers decorated with @ChatToolProvider()
  const toolWrappers = withMetatype.filter((wrapper) => {
    return this.reflector.get(CHAT_TOOL_METADATA, wrapper.metatype) === true
  })

Phase 4 — Map to instances and filter out null/undefined
  const discovered = toolWrappers.map((wrapper) => wrapper.instance)
  const validInstances = discovered.filter((instance) => instance !== null && instance !== undefined)

Phase 5 — Assign to this.tools
  this.tools = validInstances

Phase 6 — Log discovered tool count and names (info level)
  const count = this.tools.length
  const names = this.tools.map((tool) => tool.name).join(", ")
  this.logger.log(`Discovered chat tools [count=${count} names=${names}]`)

Phase 7 — Warn if zero tools found
  if (count === 0) {
    this.logger.warn("No chat tools discovered. Verify that tool classes are decorated with @ChatToolProvider() and registered in AppModule providers.")
  }
```

Style constraints to enforce during implementation:
- No `as` casts anywhere in this method — use the property-truthy filter pattern above
- No `Array<T>` syntax — use `ChatTool[]`
- No `instanceof`, `in`, `is`, `typeof` for discrimination
- Use intermediate named variables for each filter/map phase (no chained single-line array methods)
- Blank lines between each phase

`getAll()`, `getDefinitions()`, and `execute()` are unchanged in behavior.

**Done when:** File compiles, `CHAT_TOOLS_TOKEN` is gone, and `onModuleInit` is the only tool population path.

---

### Step 4 — Modify `src/app.module.ts`
**What:** Import `DiscoveryModule`, remove the factory provider block, remove `CHAT_TOOLS_TOKEN` import.

**Why here:** Depends on step 3 removing `CHAT_TOOLS_TOKEN` from `tool-registry.service.ts`. If the constant is gone from the service, the import in `app.module.ts` would be a compile error anyway.

**Implementation details:**

Imports to add:
- `DiscoveryModule` from `@nestjs/core`

Imports to remove:
- `CHAT_TOOLS_TOKEN` from `./tools/tool-registry.service`

`imports` array change:
- Add `DiscoveryModule` to the `imports` array alongside `ConfigModule.forRoot(...)`

`providers` array change:
- Remove the entire factory provider object:
  ```
  {
    provide: CHAT_TOOLS_TOKEN,
    useFactory: (saveUserFact: SaveUserFactTool) => { return [saveUserFact]; },
    inject: [SaveUserFactTool],
  }
  ```
- `SaveUserFactTool` and `ToolRegistryService` remain in providers as plain class references

**Done when:** `app.module.ts` compiles, no reference to `CHAT_TOOLS_TOKEN` remains anywhere in the file, and `DiscoveryModule` appears in `imports`.

---

### Step 5 — Modify `src/tools/tool-registry.service.spec.ts`
**What:** Replace the `CHAT_TOOLS_TOKEN`-based test setup with mocks for `DiscoveryService` and `Reflector`. Preserve all existing behavioral tests for `getAll`, `getDefinitions`, and `execute`.

**Why last:** Test changes should reflect the final service API. Writing them after steps 1–4 ensures the test module setup mirrors the real module structure.

**Implementation details:**

Imports to add:
- `DiscoveryService` from `@nestjs/core`
- `Reflector` from `@nestjs/core`
- `CHAT_TOOL_METADATA` from `./chat-tool.decorator`

Imports to remove:
- `CHAT_TOOLS_TOKEN` from `./tool-registry.service`

New test module setup pattern:

The `beforeEach` block must:
1. Create a mock `DiscoveryService` with a `getProviders()` method that returns a fake `InstanceWrapper[]` containing the mock tool with a fake `metatype`.
2. Create a mock `Reflector` with a `get()` method that returns `true` when called with `(CHAT_TOOL_METADATA, <metatype>)`.
3. Provide both mocks as values in the test module's `providers` array.
4. After `module.compile()`, call `registry.onModuleInit()` to trigger discovery before each test.

For the "multiple tools" test case in `execute`:
- Build the mock discovery wrappers to include both tools, both with metatypes that resolve to `true` via the reflector mock.

Behavioral expectations that must remain passing:
- `getAll` returns all discovered tools (length check, name check)
- `getDefinitions` maps each tool to `{ name, description, input_schema }`
- `execute` dispatches to the correct tool by name
- `execute` returns error result when tool not found
- `execute` does not throw when tool not found
- `execute` returns error result when tool's execute throws
- `execute` does not throw when tool's execute throws
- `execute` selects the correct tool when multiple are registered

New test to add:
- `onModuleInit` logs a warning when no tools are discovered — provide a `DiscoveryService` mock whose `getProviders()` returns an empty array and verify `logger.warn` was called. (This requires either spying on the Logger or injecting a mock logger.)

**Done when:** All existing tests pass, new warning test passes, and no reference to `CHAT_TOOLS_TOKEN` remains in the spec file.

---

## Risks and Edge Cases

### High: DiscoveryModule not added to imports
If `DiscoveryModule` is omitted from `AppModule.imports`, NestJS will throw at startup: "Nest can't resolve dependencies of ToolRegistryService — DiscoveryService not found." This is silent until runtime. Mitigation: treat step 4 as a checklist item and verify the import after writing the file.

### High: `wrapper.metatype` null guard
`DiscoveryService.getProviders()` returns wrappers for all registered providers, including async factory providers and value providers that have no `metatype`. Calling `this.reflector.get(CHAT_TOOL_METADATA, null)` would throw. The explicit null/undefined filter before the reflector call prevents this. Do not skip it.

### High: `wrapper.instance` timing
`getProviders()` can return wrappers whose `instance` is not yet initialized if called before NestJS has fully resolved the DI graph. `OnModuleInit` is called after all providers are initialized, so this timing is safe — but if the discovery call is ever moved outside `onModuleInit`, instance nulls become a real risk.

### Medium: `as` cast temptation on instance
The implementer may be tempted to write `wrapper.instance as ChatTool` to satisfy TypeScript. This is banned. The filtering approach (check `instance !== null && instance !== undefined`, then assign to `this.tools`) relies on the decorator as the runtime contract. If TypeScript still complains about the assignment type, use an intermediate variable typed as `unknown` and a property-truthy guard function — never `as`.

### Medium: Decorator order on SaveUserFactTool
TypeScript decorators are applied bottom-up (closest to the class first). If `@ChatToolProvider()` is placed below `@Injectable()`, the NestJS metadata pipeline may not see it correctly. It must be the outermost decorator (top line).

### Medium: Test spec — mock Reflector `get` signature
`Reflector.get` is overloaded. The mock must match the call signature used: `(metadataKey: string, target: Function) => boolean | undefined`. A simple `jest.fn().mockReturnValue(true)` will work for the happy path. For the warning test, use `jest.fn().mockReturnValue(undefined)`.

### Low: Logger.warn in test
Testing the warning log requires either injecting a mock Logger or spying on the Logger prototype. The simpler approach is `jest.spyOn(registry['logger'], 'warn')` after `onModuleInit()`. Acceptable for a low-risk log assertion.

### Low: `CHAT_TOOLS_TOKEN` lingering import
If the constant is removed from the service but the `app.module.ts` import line is not updated, TypeScript will emit a compile error. Running `npx tsc --noEmit` after each step catches this quickly.

---

## Testing Strategy

### Unit tests (tool-registry.service.spec.ts)
- All 6 existing behavioral tests must pass after the spec rewrite.
- Add 1 new test: `onModuleInit logs a warning when no tools are discovered`.
- Mock surface: `DiscoveryService.getProviders()` (returns `InstanceWrapper[]`) and `Reflector.get()` (returns `true` or `undefined`).
- Run: `npm test -- --testPathPattern=tool-registry` after each change.

### Full test suite
- Run `npm test` after all five steps are complete. All 38 existing tests must pass with no new failures.
- If any test imports `CHAT_TOOLS_TOKEN` from `tool-registry.service`, it will fail at compile time — grep for `CHAT_TOOLS_TOKEN` across `src/` before declaring done.

### Manual / e2e verification
- Start the server with `npm run start:dev`.
- Send a Discord message that triggers the `save_user_fact` tool (e.g., share a personal fact).
- Verify the startup log contains: `Discovered chat tools [count=1 names=save_user_fact]`.
- Verify the tool executes and the DynamoDB write completes (check CloudWatch or local DynamoDB for the new item).
- Verify no startup error about unresolved `DiscoveryService` or `CHAT_TOOLS_TOKEN`.

### Regression areas to re-test
- `AnthropicService` calls `ToolRegistryService.getDefinitions()` — verify tool definitions are still passed correctly to the Anthropic messages.create() call.
- `ChatSessionService` calls `ToolRegistryService.execute()` — verify tool dispatch still works after the refactor.

---

## Implementation Recommendations

**Follow the step order strictly.** Step 1 (decorator) must exist before step 2 (applying it) and step 3 (importing the constant). Step 4 must come after step 3 so the removed constant doesn't cause a dangling import. Step 5 (tests) should be the final rewrite.

**Verify compilation after each step** with `npx tsc --noEmit`. This catches import/type errors before they compound.

**The `ChatTool` interface is the runtime contract.** The decorator is only a discovery marker — it does not validate the shape. If a class is decorated but does not implement `ChatTool`, the code will fail at the `tool.name`, `tool.execute()` call sites in `getDefinitions()` and `execute()`. The `metatype` null guard and instance null filter are the only runtime defenses needed; a full `isChatTool` type-predicate guard is not allowed by style rules and is not necessary given the decorator-as-contract approach.

**grep before declaring done:**
```
grep -r "CHAT_TOOLS_TOKEN" src/
```
Result must be zero matches.

**For the spec rewrite**, look at how other service specs in the codebase mock NestJS providers to match the `useValue` pattern already in place. The existing `makeMockTool` helper is reusable — keep it. Only the module setup and `onModuleInit` call change.
